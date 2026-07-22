# Leftover Stock Management + Warehouse Aging — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bank usable offcut strips from cutting odd parent sheets as reusable warehouse stock (decided at planning, booked automatically at cutting), and add warehouse-wide 30/60/90 stock aging.

**Architecture:** Leftovers are ordinary `materials` rows (category `board`, `leftover=1`, auto code `LO-…`) so FIFO issue, WarehousePicker, Smart Match and the ledger work unchanged. The planner's decision is stored as `order_lines.leftover_plan` JSONB; the cutting-stage completion books a dated `stock_batches` row from actual parents cut. Aging is a read-only endpoint bucketing batches and FG lots by `created_at`.

**Tech Stack:** Express + node-postgres (server/src), React 18 + Vite + Tailwind (client/src), embedded PostgreSQL on port 5439. Dev: `npm run dev` (API 4000, Vite 5173), login `admin@ci.local` / `admin123`.

**Spec:** `docs/superpowers/specs/2026-07-07-leftover-stock-aging-design.md`

**⚠️ NO GIT COMMITS.** Anik's standing rule: never `git add`/`git commit`/`git push` in this repo. Every task ends with a verification run instead of a commit.

**UAT convention:** tests are API-level scripts in the session scratchpad (`$SCRATCHPAD/uat-leftover.mjs`), run with `node` against the live dev server with real migrated data — same pattern as the existing `uat-planning.mjs` (35-suite family). Each task appends its section to the script, runs it to see the new checks FAIL, implements, then re-runs to see them PASS. `$SCRATCHPAD` = this session's scratchpad directory.

---

### Task 1: Schema migrations + UAT harness

**Files:**
- Modify: `server/src/db.js` (migrations block, ~line 456–520 — the `ALTER TABLE …` pool.query)
- Create: `$SCRATCHPAD/uat-leftover.mjs`

- [ ] **Step 1: Create the UAT harness with the schema check**

```js
// $SCRATCHPAD/uat-leftover.mjs
// Leftover stock + warehouse aging UAT — runs against the live dev API (real data).
const API = 'http://localhost:4000/api';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };
const login = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@ci.local', password: 'admin123' }) }).then(r => r.json());
const H = { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' };
const get = u => fetch(API + u, { headers: H }).then(async r => { if (!r.ok) throw new Error(`GET ${u} → ${r.status}: ${await r.text()}`); return r.json(); });
const post = (u, b) => fetch(API + u, { method: 'POST', headers: H, body: JSON.stringify(b) }).then(async r => { if (!r.ok) { const t = await r.text(); const e = new Error(`POST ${u} → ${r.status}: ${t}`); e.status = r.status; throw e; } return r.json(); });
const postFail = async (u, b) => { try { await post(u, b); return null; } catch (e) { return e.status; } };

console.log('— 1. schema: leftover columns visible through the API');
// masters list returns materials rows — new columns must be present (null/0 on old rows)
const mats = await get('/masters/materials');
ok('materials rows have leftover flag', mats.length > 0 && mats.every(m => 'leftover' in m));
ok('materials rows have code column', mats.every(m => 'code' in m));
ok('materials rows have source_material_id', mats.every(m => 'source_material_id' in m));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node "$SCRATCHPAD/uat-leftover.mjs"`
Expected: FAIL — `'leftover' in m` is false (columns don't exist yet).
(If the dev server isn't running: `cd ci-erp && npm run dev` in background first.)

- [ ] **Step 3: Add the migrations**

In `server/src/db.js`, append inside the existing migrations `pool.query(\`…\`)` block (after the `ALTER TABLE users ADD COLUMN IF NOT EXISTS modules JSONB;` line):

```sql
-- Leftover offcut stock: a leftover is a board material carved from a parent
-- board. One master per (source board, strip size); code LO-<srcId>-<L>X<W>.
ALTER TABLE materials ADD COLUMN IF NOT EXISTS code TEXT;
ALTER TABLE materials ADD COLUMN IF NOT EXISTS leftover INTEGER NOT NULL DEFAULT 0;
ALTER TABLE materials ADD COLUMN IF NOT EXISTS source_material_id INTEGER REFERENCES materials(id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_materials_code ON materials(code) WHERE code IS NOT NULL;
-- Planner's push-to-warehouse decision, taken once in the Planning Engine.
ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS leftover_plan JSONB;
```

And extend the `stock_movements` type CHECK (replace the existing DROP/ADD pair for `stock_movements_type_check`):

```sql
ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_type_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_type_check
  CHECK (type IN ('grn','qc_release','qc_reject','consumption','adjustment','fg_receipt','dispatch','wastage','leftover_in'));
```

- [ ] **Step 4: Restart the dev server (migrations run at boot) and re-run**

Run: restart `npm run dev`, then `node "$SCRATCHPAD/uat-leftover.mjs"`
Expected: PASS (3 checks). Note: `/masters/materials` is the generic masters route; if the route is `/materials`, check `server/src/routes/masters.js` line ~13 for the mount path and adjust the UAT URL — the assertion stays the same.

---

### Task 2: `leftoverStrips` pure helper

**Files:**
- Modify: `server/src/helpers.js` (after `childFit`, ~line 88)

- [ ] **Step 1: Append the failing check to the UAT script** (insert before the final summary lines; keep the summary last in every task)

```js
console.log('— 2. leftoverStrips math (pure import)');
const { leftoverStrips } = await import('file:///Users/anikdua/Documents/Projects/Colour Imp Production/Colour Imp Production/ci-erp/server/src/helpers.js'.replace(/ /g, '%20'));
// 25×30 parent cutting 18×23 child (1-up): strips 7×30 and 18×7
const s1 = leftoverStrips({ sheet_l: 25, sheet_w: 30 }, { child_l: 18, child_w: 23 });
ok('two strips returned', s1.length === 2, JSON.stringify(s1));
ok('7×30 strip present + usable', s1.some(s => s.l === 30 && s.w === 7 && s.usable));
ok('18×7 strip present + usable', s1.some(s => s.l === 18 && s.w === 7 && s.usable));
// exact fit leaves nothing: 36×46 cutting 18×23 (2×2)
ok('exact fit → no strips', leftoverStrips({ sheet_l: 36, sheet_w: 46 }, { child_l: 18, child_w: 23 }).length === 0);
// sliver under 3" is flagged unusable: 20×24 cutting 18×23 → 2×24 and 18×1
const s2 = leftoverStrips({ sheet_l: 20, sheet_w: 24 }, { child_l: 18, child_w: 23 });
ok('slivers flagged not usable', s2.every(s => !s.usable), JSON.stringify(s2));
// no fit at all → no strips
ok('no fit → no strips', leftoverStrips({ sheet_l: 10, sheet_w: 10 }, { child_l: 18, child_w: 23 }).length === 0);
```

- [ ] **Step 2: Run to verify it fails**

Run: `node "$SCRATCHPAD/uat-leftover.mjs"`
Expected: FAIL — `leftoverStrips` is not exported.

- [ ] **Step 3: Implement in `server/src/helpers.js`** (directly after `childFit`)

```js
// Guillotine remainder of the winning childFit layout. Cutting nL×nW children
// out of a parent leaves two rectangular offcut strips: one down the length,
// one under the grid. Dims are normalized l ≥ w; strips under 3" on the short
// side are real cuts but not bankable stock (usable=false).
export function leftoverStrips(parent, child) {
  const fit = childFit(parent, child);
  if (!fit.sized || fit.count <= 0) return [];
  const PL = +parent.sheet_l, PW = +parent.sheet_w;
  const [cl, cw] = fit.orientation === 'rotated'
    ? [+child.child_w, +child.child_l] : [+child.child_l, +child.child_w];
  const EPS = 1e-6;
  const nL = Math.floor(PL / cl + EPS), nW = Math.floor(PW / cw + EPS);
  const raw = [
    { l: +(PL - nL * cl).toFixed(2), w: PW },        // strip along the length
    { l: +(nL * cl).toFixed(2), w: +(PW - nW * cw).toFixed(2) }, // strip under the grid
  ];
  return raw
    .map(s => ({ l: Math.max(s.l, s.w), w: Math.min(s.l, s.w) }))
    .filter(s => s.w > 0.05)
    .map(s => ({ ...s, usable: s.w >= 3, strips_per_parent: 1 }));
}
```

- [ ] **Step 4: Re-run** — Expected: PASS. (The import URL trick: helpers.js imports db.js which opens a pool lazily; `process.exit` at the script end prevents a hang. If the `%20` URL fails on import, copy helpers.js's `childFit`-based math check into a tiny scratch file instead — assertions unchanged.)

---

### Task 3: `findOrCreateLeftoverMaster` helper

**Files:**
- Modify: `server/src/helpers.js` (after `leftoverStrips`)

This helper is exercised end-to-end in Task 6 (booking); no isolated UAT step — it needs a transaction. Implement now so Tasks 4–6 can import it.

- [ ] **Step 1: Implement**

```js
// One leftover master per (source board, strip size), orientation-agnostic.
// Code LO-<sourceId>-<L>X<W> (decimal point → P, so 7.5 → 7P5). qc/oc are the
// transaction's query/one — always called inside a tx.
export async function findOrCreateLeftoverMaster(sourceBoard, strip, qc, oc) {
  const L = Math.max(+strip.l, +strip.w), W = Math.min(+strip.l, +strip.w);
  const existing = await oc(`
    SELECT * FROM materials
    WHERE leftover=1 AND source_material_id=$1
      AND ABS(GREATEST(sheet_l, sheet_w) - $2) < 0.01
      AND ABS(LEAST(sheet_l, sheet_w) - $3) < 0.01`,
    [sourceBoard.id, L, W]);
  if (existing) return existing;
  const dim = n => String(+(+n).toFixed(2)).replace('.', 'P');
  const code = `LO-${sourceBoard.id}-${dim(L)}X${dim(W)}`;
  const [m] = await qc(`
    INSERT INTO materials (name, category, spec, unit, sheet_l, sheet_w, reorder_level,
                           code, leftover, source_material_id)
    VALUES ($1,'board',$2,'sheets',$3,$4,0,$5,1,$6)
    ON CONFLICT (code) DO NOTHING RETURNING *`,
    [`Leftover — ${sourceBoard.name} · ${L}×${W}"`, sourceBoard.spec, L, W, code, sourceBoard.id]);
  // Concurrent insert raced us: the row exists now, fetch it.
  return m || await oc('SELECT * FROM materials WHERE code=$1', [code]);
}
```

Note: `ON CONFLICT (code)` targets `idx_materials_code`, a partial unique index — Postgres requires `ON CONFLICT (code) WHERE code IS NOT NULL` for partial indexes. Write it as:
`ON CONFLICT (code) WHERE code IS NOT NULL DO NOTHING RETURNING *`.

- [ ] **Step 2: Verify the server still boots clean**

Run: restart dev server; `curl -s http://localhost:4000/api/health || node "$SCRATCHPAD/uat-leftover.mjs"`
Expected: existing checks still PASS (no regression from the edit).

---

### Task 4: Planning context returns `leftover`

**Files:**
- Modify: `server/src/routes/orders.js` — import line 4, and `/planning/:lineId/context` (~line 305–387)

- [ ] **Step 1: Append the failing UAT section**

```js
console.log('— 3. planning context exposes leftover strips');
const planning = await get('/planning');
const line = planning.find(l => ['pending', 'planned'].includes(l.status) && l.child_l > 0 && l.child_w > 0);
if (!line) throw new Error('no sized plannable line found');
const ctx = await get(`/planning/${line.id}/context`);
ok('context has leftover key', 'leftover' in ctx);
if (ctx.leftover) {
  ok('strips have dims + usable + est_sheets', ctx.leftover.strips.every(s => s.l > 0 && s.w >= 0 && 'usable' in s && 'est_sheets' in s));
  ok('saved decision echoed (null before any plan)', 'saved' in ctx.leftover);
}
```

- [ ] **Step 2: Run — expect FAIL** (`'leftover' in ctx` false).

- [ ] **Step 3: Implement in orders.js**

Add to the import from helpers.js (line 4): `leftoverStrips`.
In the context route, after the `gang` block (~line 363) and before `res.json({…})`:

```js
    // Expected guillotine offcut of this board + child pairing. The planner
    // decides here — once — whether cutting should bank it in the warehouse.
    const strips = leftoverStrips(
      { sheet_l: board?.sheet_l, sheet_w: board?.sheet_w },
      { child_l: line.child_l, child_w: line.child_w });
    const leftover = strips.length ? {
      strips: strips.map(s => ({ ...s, est_sheets: line.parent_sheets_required || 0 })),
      saved: line.leftover_plan || null,
    } : null;
```

Add `leftover,` to the `res.json({ line, board, gang, … })` object.

- [ ] **Step 4: Re-run — expect PASS.**

---

### Task 5: Plan POST stores the leftover decision

**Files:**
- Modify: `server/src/routes/orders.js` — plan POST handler (~line 215–301)

- [ ] **Step 1: Append the failing UAT section**

```js
console.log('— 4. plan POST persists the leftover decision');
// pick the first usable strip the context offered (skip the whole section if none)
const strip = ctx.leftover?.strips.find(s => s.usable);
if (strip) {
  const p1 = await post(`/order-lines/${line.id}/plan`, {
    tooling_ok: false, wastage_sheets: 150, spec: {}, update_master: false,
    leftover: { push: true, strip: { l: strip.l, w: strip.w } },
  });
  ok('leftover_plan stored with push', p1.leftover_plan?.push === true, JSON.stringify(p1.leftover_plan));
  ok('strip echoed', p1.leftover_plan?.strip?.l === strip.l && p1.leftover_plan?.strip?.w === strip.w);
  ok('est_sheets = parent sheets', p1.leftover_plan?.est_sheets === p1.parent_sheets_required);
  // explicit decline clears it
  const p2 = await post(`/order-lines/${line.id}/plan`, {
    tooling_ok: false, wastage_sheets: 150, spec: {}, update_master: false, leftover: { push: false },
  });
  ok('push=false clears leftover_plan', p2.leftover_plan == null);
  // bogus strip is rejected 409
  ok('nonsense strip → 409', await postFail(`/order-lines/${line.id}/plan`, {
    tooling_ok: false, wastage_sheets: 150, spec: {}, update_master: false,
    leftover: { push: true, strip: { l: 999, w: 1 } },
  }) === 409);
  // restore the push=true plan for the booking task downstream
  await post(`/order-lines/${line.id}/plan`, {
    tooling_ok: false, wastage_sheets: 150, spec: {}, update_master: false,
    leftover: { push: true, strip: { l: strip.l, w: strip.w } },
  });
} else console.log('  (board fits exactly — no usable strip; section skipped)');
```

- [ ] **Step 2: Run — expect FAIL** (leftover_plan stays null; 409 check fails with 200).

- [ ] **Step 3: Implement in the plan POST**

Destructure `leftover` from the body (line ~218):
`const { machine_id, planned_date, tooling_ok, wastage_sheets, notes, spec = {}, update_master, leftover } = req.body;`

After `const parentSheets = parentSheetsRequired(sheets, fit.count);` (~line 263):

```js
      // Leftover decision — validated against the effective board's real
      // strips so a stale client can't book nonsense. Rules:
      //   leftover sent        → store it (push:false stores NULL)
      //   leftover absent      → keep the saved decision, UNLESS the board
      //                          changed in this lock (strips no longer match).
      let leftoverPlan = null;
      if (leftover?.push && leftover.strip) {
        const strips = leftoverStrips(board, eff);
        const pick = strips.find(s =>
          Math.abs(s.l - +leftover.strip.l) < 0.01 && Math.abs(s.w - +leftover.strip.w) < 0.01);
        if (!pick) throw Object.assign(new Error('Leftover strip does not match this board\'s cut plan'), { status: 409 });
        if (!pick.usable) throw Object.assign(new Error(`Strip ${pick.l}×${pick.w}" is under 3" — waste, not stock`), { status: 409 });
        leftoverPlan = { push: true, strip: { l: pick.l, w: pick.w }, strips_per_parent: pick.strips_per_parent,
                         est_sheets: parentSheets, decided_by: req.user.name, decided_at: new Date().toISOString() };
      }
      const keepSaved = leftover === undefined && !changed.board_material_id;
      const prevPlan = typeof line.leftover_plan === 'string' ? JSON.parse(line.leftover_plan) : line.leftover_plan;
      const finalLeftover = leftover !== undefined ? leftoverPlan : (keepSaved ? prevPlan : null);
```

Extend the UPDATE (~line 264) — add `leftover_plan=$X` to the SET list and `finalLeftover ? JSON.stringify(finalLeftover) : null` to the params, renumbering `WHERE id=` accordingly:

```js
      await qc(`UPDATE order_lines SET machine_id=COALESCE($1, machine_id), planned_date=COALESCE($2, planned_date),
                  sheets_required=$3, parent_sheets_required=$4,
                  tooling_ok=COALESCE($5, tooling_ok), spec_override=$6, wastage_sheets=$7, notes=$8,
                  leftover_plan=$9 WHERE id=$10`,
        [machine_id || null, planned_date || null, sheets, parentSheets,
         tooling_ok === undefined ? null : (tooling_ok ? 1 : 0),
         jobOverride ? JSON.stringify(jobOverride) : null,
         wastage, notes === undefined ? line.notes : (notes || null),
         finalLeftover ? JSON.stringify(finalLeftover) : null, line.id]);
```

When `finalLeftover?.push`, append to the existing plan audit detail string: `` + `, leftover ${finalLeftover.strip.l}×${finalLeftover.strip.w}" → warehouse` ``.

- [ ] **Step 4: Re-run — expect PASS.** Also re-run the regression: `node "$SCRATCHPAD_OF_PRIOR_SUITES/uat-planning.mjs"` if present (29 checks must stay green — the plan POST is shared).

---

### Task 6: Cutting completion banks the leftover

**Files:**
- Modify: `server/src/routes/production.js` — import (line 9) and complete handler (~line 218–309)

- [ ] **Step 1: Append the failing UAT section**

```js
console.log('— 5. cutting completion books the leftover');
let loMat = null; // top-level: tasks 7–9's sections read this after the block below
if (strip) {
  // Drive the planned line through: job card → start cutting → complete cutting.
  // Board stock may be short on real data — self-provision like uat-sections.mjs.
  const fresh = await get(`/planning/${line.id}/context`).then(c => c.line ?? line);
  const need = (fresh.parent_sheets_required ?? line.parent_sheets_required) || 50;
  await post('/inventory/adjust', { material_id: ctx.board.id, qty: need + 10, batch_no: `UAT-LO-${Date.now()}`, note: 'uat-leftover provision' });
  let jc;
  try { jc = await post(`/order-lines/${line.id}/job-card`, {}); }
  catch (e) { if (e.status !== 409) throw e; jc = (await get('/job-cards')).find(j => j.order_line_id === line.id); }
  const stages = await get(`/job-cards/${jc.id}/stages`);
  const cutting = stages.find(s => s.stage === 'cutting');
  await post(`/job-stages/${cutting.id}/start`, {});
  const started = await get(`/job-cards/${jc.id}/stages`).then(ss => ss.find(s => s.id === cutting.id));
  const cap = started.qty_in * Math.max(1, jc.children_per_parent || 1);
  await post(`/job-stages/${cutting.id}/complete`, { qty_out: cap, qty_scrap: 0 });
  // The booking:
  const lows = (await get('/inventory/batches')).filter(b => b.batch_no === `LO-${jc.jc_number}`);
  ok('one LO batch created', lows.length === 1, `found ${lows.length}`);
  ok('batch qty = parents cut', lows[0]?.qty === started.qty_in, `got ${lows[0]?.qty} want ${started.qty_in}`);
  loMat = (await get('/masters/materials')).find(m => m.leftover === 1 && m.source_material_id === ctx.board.id
    && Math.max(m.sheet_l, m.sheet_w) === Math.max(strip.l, strip.w));
  ok('leftover master auto-created with LO code', !!loMat && /^LO-\d+-/.test(loMat.code), loMat?.code);
  const moves = await get('/inventory/movements');
  ok('leftover_in movement in the ledger', moves.some(m => m.type === 'leftover_in' && m.material_name === loMat?.name));
} else console.log('  (skipped — no usable strip on this line)');
```

Adjust route names to the codebase if they differ (`/order-lines/:id/job-card`, `/job-cards/:id/stages` — check `server/src/routes/production.js` lines 1–90 and the existing `uat-sections.mjs` for the exact URLs; assertions stay identical).

- [ ] **Step 2: Run — expect FAIL** (no LO batch created).

- [ ] **Step 3: Implement in production.js**

Import: add `findOrCreateLeftoverMaster` to the helpers import (line 9).
In the complete handler, after the stage UPDATE + audit (~line 283) and before the wastage-ledger block, add:

```js
      // Bank the planned leftover offcut — booked once per job card, from the
      // ACTUAL parents cut (qty_in), not the planned figure. Idempotent via
      // the LO-<jc_number> batch_no, so retries and stage adjustments can't
      // double-book. Declined/absent plan = no-op.
      if (st.stage === 'cutting') {
        const lp = await oc(`
          SELECT ol.leftover_plan, jc.jc_number,
                 COALESCE((ol.spec_override->>'board_material_id')::int, p.board_material_id) AS board_material_id
          FROM job_cards jc JOIN order_lines ol ON ol.id=jc.order_line_id
          JOIN products p ON p.id=ol.product_id WHERE jc.id=$1`, [st.job_card_id]);
        const plan = typeof lp?.leftover_plan === 'string' ? JSON.parse(lp.leftover_plan) : lp?.leftover_plan;
        if (plan?.push && plan.strip) {
          const batchNo = `LO-${lp.jc_number}`;
          const dup = await oc('SELECT id FROM stock_batches WHERE batch_no=$1', [batchNo]);
          if (!dup) {
            const srcBoard = await oc('SELECT * FROM materials WHERE id=$1', [lp.board_material_id]);
            const master = await findOrCreateLeftoverMaster(srcBoard, plan.strip, qc, oc);
            const loQty = (plan.strips_per_parent || 1) * st.qty_in;
            const [loBatch] = await qc(`
              INSERT INTO stock_batches (material_id, batch_no, qty, initial_qty, unit, status)
              VALUES ($1,$2,$3,$3,'sheets','available') RETURNING id`, [master.id, batchNo, loQty]);
            await qc(`INSERT INTO stock_movements (material_id, batch_id, type, qty, ref_type, ref_id, note)
                      VALUES ($1,$2,'leftover_in',$3,'job_stage',$4,$5)`,
              [master.id, loBatch, loQty, st.id,
               `Leftover ${plan.strip.l}×${plan.strip.w}" banked from ${lp.jc_number}`]);
            await audit('material', master.id, 'leftover_in',
              `${loQty} sheets ${plan.strip.l}×${plan.strip.w}" from ${lp.jc_number}`, qc, req.user.name);
          }
        }
      }
```

Watch the destructuring: `qc` INSERT RETURNING gives rows — `const [loBatch] = await qc(…)` yields the row; use `loBatch.id` in the movement insert (fix the param accordingly: `[master.id, loBatch.id, …]`).

- [ ] **Step 4: Re-run — expect PASS.** Then re-run once more end-to-end: the booking checks must STILL pass with `one LO batch created` = 1 (idempotency — the UAT reruns the whole flow; a second batch would show `found 2`... note the second run creates a NEW plan/JC on possibly the same line; if the line is already produced the script picks the next plannable line, which is fine — the idempotency assertion is per jc_number).

---

### Task 7: Leftovers cannot be purchased

**Files:**
- Modify: `server/src/routes/procurement.js` — `POST /requisitions` (~line 60)
- Modify: `server/src/routes/orders.js` — `POST /order-lines/:id/raise-pr` (~line 481)

- [ ] **Step 1: Append the failing UAT section**

```js
console.log('— 6. procurement guard: leftovers are not purchasable');
const anyLo = (await get('/masters/materials')).find(m => m.leftover === 1);
if (anyLo) {
  ok('PR for a leftover → 409', await postFail('/requisitions', { material_id: anyLo.id, qty: 100 }) === 409);
} else console.log('  (no leftover master yet — run after task 6 created one)');
```

- [ ] **Step 2: Run — expect FAIL** (PR is created, no 409).

- [ ] **Step 3: Implement**

In `procurement.js` `POST /requisitions`, after the `if (!material_id || !qty)` guard:

```js
    const mat = await one('SELECT leftover, name FROM materials WHERE id=$1', [material_id]);
    if (mat?.leftover)
      return res.status(409).json({ error: `${mat.name} is a leftover offcut — it cannot be purchased. Pick a fresh board.` });
```

(Import `one` from `../db.js` if the file only imports `q, tx`.)

In `orders.js` raise-pr, after the shortage calculation and before `nextNumber`:

```js
    const boardRow = await one('SELECT leftover, name FROM materials WHERE id=$1', [gate.board_material_id]);
    if (boardRow?.leftover)
      return res.status(409).json({ error: `${boardRow.name} is a leftover offcut — raise the PR against its parent board instead.` });
```

- [ ] **Step 4: Re-run — expect PASS.**

---

### Task 8: Smart Match knows leftovers (family/GSM via parent, ranked first)

**Files:**
- Modify: `server/src/routes/orders.js` — smart-match candidates SQL (~line 407–418)
- Modify: `server/src/smartmatch.js` — `boardGsm`, `boardFamily`, `rankBoardMatches`

- [ ] **Step 1: Append the failing UAT section**

```js
console.log('— 7. smart match ranks a fitting leftover first');
// Find (or make) a line whose child fits the leftover created in task 5.
if (typeof loMat !== 'undefined' && loMat) {
  const fitLine = planning.find(l => l.child_l > 0 && l.child_w > 0
    && (Math.floor(Math.max(loMat.sheet_l, loMat.sheet_w) / Math.max(l.child_l, l.child_w))
      * Math.floor(Math.min(loMat.sheet_l, loMat.sheet_w) / Math.min(l.child_l, l.child_w))) > 0
    && ['pending', 'planned'].includes(l.status));
  if (fitLine) {
    const sm = await get(`/planning/${fitLine.id}/smart-match`);
    const loHit = sm.matches.find(m => m.material_id === loMat.id);
    ok('leftover appears in smart match', !!loHit);
    if (loHit) {
      ok('leftover flagged', loHit.leftover === true);
      ok('leftover ranked first among matches', sm.matches[0].leftover === true, `first = ${sm.matches[0].name}`);
    }
  } else console.log('  (no line whose child fits the leftover — acceptable on real data, assert flag only)');
}
```

- [ ] **Step 2: Run — expect FAIL** (leftover missing or `leftover` flag undefined). Note the family/GSM filters previously excluded leftovers because their name starts "Leftover — …" (wrong family); this task fixes exactly that.

- [ ] **Step 3: Implement**

orders.js candidates SQL — join the source parent and expose match identity:

```sql
      SELECT m.*, COALESCE(av.q,0) AS available, COALESCE(cm.q,0) AS committed,
             COALESCE(src.name, m.name) AS match_name, COALESCE(src.spec, m.spec) AS match_spec
      FROM materials m
      LEFT JOIN materials src ON src.id = m.source_material_id
      LEFT JOIN (SELECT material_id, SUM(qty) AS q FROM stock_batches
                 WHERE status='available' GROUP BY material_id) av ON av.material_id=m.id
      LEFT JOIN (SELECT ${EFF_BOARD_ID} AS mid,
                        SUM(COALESCE(ol.parent_sheets_required, ol.sheets_required)) AS q
                 FROM order_lines ol JOIN products p ON p.id=ol.product_id
                 WHERE ol.status IN ('planned','ready') AND ol.id != $1 GROUP BY 1) cm ON cm.mid=m.id
      WHERE m.category='board' AND m.sheet_l > 0 AND m.sheet_w > 0
        AND (COALESCE(av.q,0) > 0 OR m.id = $2)
```

smartmatch.js — family/GSM read the match identity (parent for leftovers):

```js
export function boardGsm(material) {
  const nm = material?.match_name ?? material?.name;
  const sp = material?.match_spec ?? material?.spec;
  const m = String(nm || '').match(/(\d{2,4})\s*gsm/i)
    || String(sp || '').match(/[A-Za-z](\d{3})(?:-|$)/);
  return m ? +m[1] : null;
}

export function boardFamily(material) {
  const name = String(material?.match_name ?? material?.name ?? '');
  const head = name.split('·')[0].trim();
  return (head || name).toLowerCase();
}
```

`rankBoardMatches` — add the flag to the pushed object (inside `out.push({ … })`):
`leftover: !!c.leftover, code: c.code || null,`
and make leftovers the primary sort key (replace the comparator):

```js
  out.sort((a, b) => {
    if (!!a.leftover !== !!b.leftover) return a.leftover ? -1 : 1; // use offcuts first
    if (b.score !== a.score) return b.score - a.score;
    if (a.sufficient !== b.sufficient) return a.sufficient ? -1 : 1;
    if (a.category !== b.category) return rank[a.category] - rank[b.category];
    return b.free - a.free;
  });
```

- [ ] **Step 4: Re-run — expect PASS.** Regression: existing `uat-planning.mjs` smart-match checks (sorted-by-score) — the sort is now leftover-first; if that suite asserts strict score ordering across ALL matches and a leftover is present, the assertion may legitimately fail. Verify and, if so, note it for Anik rather than weakening this feature.

---

### Task 9: Warehouse picker shows and filters leftovers

**Files:**
- Modify: `server/src/routes/inventory.js` — `/warehouse/paper` (~line 63–115)
- Modify: `client/src/components/WarehousePicker.jsx`

- [ ] **Step 1: Append the failing UAT section**

```js
console.log('— 8. /warehouse/paper leftover fields + filter');
const wh = await get('/warehouse/paper?leftover_only=1&in_stock=1');
ok('leftover_only returns only leftovers', wh.rows.every(r => r.leftover === 1), JSON.stringify(wh.rows.map(r => r.name)));
if (typeof loMat !== 'undefined' && loMat) ok('banked leftover findable', wh.rows.some(r => r.id === loMat.id));
const whAll = await get('/warehouse/paper?in_stock=1');
ok('rows expose leftover + code', whAll.rows.every(r => 'leftover' in r && 'code' in r));
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement**

inventory.js `/warehouse/paper`:
- add after the `inStock` line: `if (req.query.leftover_only === '1') where.push('m.leftover=1');`
- search also matches the code: change the search push to
  `where.push(\`(m.name ILIKE ${p} OR m.spec ILIKE ${p} OR m.code ILIKE ${p})\`);`
- SELECT gains `m.code, m.leftover,` after `m.unit,`.

WarehousePicker.jsx:
- new state `const [loOnly, setLoOnly] = useState(false);` (reset to false in the `open` effect);
- in the params effect: `if (loOnly) params.set('leftover_only', '1');` and add `loOnly` to the dep array;
- filter row, after the "In stock only" checkbox:
  `<Checkbox label="Leftovers only" checked={loOnly} onChange={e => { setLoOnly(e.target.checked); setPage(1); }} />`
- board name cell — badge next to the name:

```jsx
<div className="flex items-center gap-1.5 font-semibold text-slate-800">
  <span className="min-w-0 truncate">{r.name}</span>
  {r.leftover === 1 && <span className="shrink-0 rounded-full bg-violet-50 px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-violet-600">Leftover</span>}
</div>
```

- [ ] **Step 4: Re-run — expect PASS.** UI check per preview workflow: open Planning → engine → Warehouse, tick "Leftovers only", see the banked strip with its badge.

---

### Task 10: Aging + leftovers endpoints

**Files:**
- Modify: `server/src/routes/inventory.js` (append before `export default r;`)

- [ ] **Step 1: Append the failing UAT section**

```js
console.log('— 9. aging + leftovers endpoints');
const aging = await get('/inventory/aging');
ok('aging has raw/fg/summary', Array.isArray(aging.raw) && Array.isArray(aging.fg) && !!aging.summary);
ok('raw rows bucketed', aging.raw.every(b => ['0-30', '31-60', '61-90', '90+'].includes(b.bucket) && b.age_days >= 0));
ok('fg lots bucketed', aging.fg.every(b => ['0-30', '31-60', '61-90', '90+'].includes(b.bucket)));
ok('summary counts match raw rows', ['0-30', '31-60', '61-90', '90+']
  .reduce((s, k) => s + (aging.summary.raw[k]?.count || 0), 0) === aging.raw.length);
const lo = await get('/inventory/leftovers');
ok('leftovers endpoint returns masters + lots', Array.isArray(lo.masters) && Array.isArray(lo.lots));
if (typeof loMat !== 'undefined' && loMat) {
  ok('banked master listed with source name', lo.masters.some(m => m.id === loMat.id && m.source_name));
  ok('its lot has age_days', lo.lots.some(l => l.material_id === loMat.id && l.age_days >= 0));
}
```

- [ ] **Step 2: Run — expect FAIL** (404s).

- [ ] **Step 3: Implement in inventory.js**

```js
// ── Warehouse aging — how long every batch and FG lot has been lying there ──
const AGE_BUCKETS = ['0-30', '31-60', '61-90', '90+'];
const bucketOf = d => d <= 30 ? '0-30' : d <= 60 ? '31-60' : d <= 90 ? '61-90' : '90+';

r.get('/inventory/aging', async (_req, res, next) => {
  try {
    const raw = await q(`
      SELECT b.id, b.batch_no, b.qty, b.unit, b.created_at,
             m.id AS material_id, m.name AS material_name, m.code, m.leftover, m.category,
             FLOOR(EXTRACT(EPOCH FROM (now() - b.created_at)) / 86400)::int AS age_days
      FROM stock_batches b JOIN materials m ON m.id=b.material_id
      WHERE b.status='available' AND b.qty > 0
      ORDER BY b.created_at`);
    const fg = await q(`
      SELECT fl.id, fl.lot_number, (fl.qty - fl.consumed_qty) AS qty, fl.created_at, fl.status,
             p.id AS product_id, p.name AS product_name, p.code,
             FLOOR(EXTRACT(EPOCH FROM (now() - fl.created_at)) / 86400)::int AS age_days
      FROM fg_lots fl JOIN products p ON p.id=fl.product_id
      WHERE fl.status IN ('pending_verification','verified') AND (fl.qty - fl.consumed_qty) > 0
      ORDER BY fl.created_at`);
    const sum = rows => Object.fromEntries(AGE_BUCKETS.map(k => {
      const hit = rows.filter(r0 => bucketOf(r0.age_days) === k);
      return [k, { count: hit.length, qty: hit.reduce((s, r0) => s + +r0.qty, 0) }];
    }));
    res.json({
      raw: raw.map(r0 => ({ ...r0, bucket: bucketOf(r0.age_days) })),
      fg: fg.map(r0 => ({ ...r0, bucket: bucketOf(r0.age_days) })),
      summary: { raw: sum(raw), fg: sum(fg) },
    });
  } catch (e) { next(e); }
});

// ── Leftover stock — dedicated view: masters with their dated lots ─────────
r.get('/inventory/leftovers', async (_req, res, next) => {
  try {
    const masters = await q(`
      SELECT m.*, src.name AS source_name, COALESCE(av.q,0) AS available
      FROM materials m
      LEFT JOIN materials src ON src.id=m.source_material_id
      LEFT JOIN (SELECT material_id, SUM(qty) q FROM stock_batches
                 WHERE status='available' GROUP BY material_id) av ON av.material_id=m.id
      WHERE m.leftover=1 ORDER BY m.name`);
    const lots = await q(`
      SELECT b.*, m.name AS material_name, m.code,
             FLOOR(EXTRACT(EPOCH FROM (now() - b.created_at)) / 86400)::int AS age_days
      FROM stock_batches b JOIN materials m ON m.id=b.material_id
      WHERE m.leftover=1 AND b.status='available' AND b.qty > 0
      ORDER BY b.created_at`);
    res.json({ masters, lots: lots.map(l => ({ ...l, bucket: bucketOf(l.age_days) })) });
  } catch (e) { next(e); }
});
```

- [ ] **Step 4: Re-run — expect PASS.**

---

### Task 11: Planning Engine "Leftover" card

**Files:**
- Modify: `client/src/pages/Planning.jsx` — state near `openPlan` (~line 173), `savePlan` (~line 291), right column after the Board Position `</Card>` (~line 656)

No API-level test — verify with the preview workflow (steps 4–5).

- [ ] **Step 1: State + init.** Add with the other useState hooks: `const [lo, setLo] = useState({ push: false, strip: null });`
In `openPlan` (after `setForm({ … })`):

```js
    const savedLo = typeof l.leftover_plan === 'string' ? JSON.parse(l.leftover_plan) : l.leftover_plan;
    setLo(savedLo?.push ? { push: true, strip: savedLo.strip } : { push: false, strip: null });
```

Also reset on board switch — in `pickBoard`, `undoBoard`, `resetBoard` add `setLo({ push: false, strip: null });` (a new board has different strips).

- [ ] **Step 2: Send it in `savePlan`.** Add to the POST body: `leftover: lo.push && lo.strip ? { push: true, strip: lo.strip } : { push: false },`
And to the success toast, when `lo.push && lo.strip`: `` + ` · leftover ${lo.strip.l}×${lo.strip.w}" → warehouse after cutting` ``.

- [ ] **Step 3: The card.** Import `Scissors` from `lucide-react` (extend the existing import). In the RIGHT column, directly after the Board Position card's closing `</Card>`:

```jsx
                {/* Leftover offcut — the planner decides once, here; cutting
                    banks it automatically from actual parents cut. */}
                {ctx?.leftover && (
                  <Card icon={Scissors} title="Leftover"
                    sub="offcut strips this cut plan leaves on the parent sheet">
                    <div className="space-y-1.5">
                      {ctx.leftover.strips.map((s, i) => {
                        const sel = lo.push && lo.strip && Math.abs(lo.strip.l - s.l) < 0.01 && Math.abs(lo.strip.w - s.w) < 0.01;
                        return (
                          <button key={i} type="button" disabled={!s.usable}
                            onClick={() => setLo({ push: true, strip: { l: s.l, w: s.w } })}
                            className={`flex w-full items-center justify-between rounded-xl px-2.5 py-2 text-xs transition
                              ${sel ? 'bg-[#0A84FF]/[0.08] ring-1 ring-[#0A84FF]/30' : 'bg-slate-50 hover:bg-slate-100'}
                              ${s.usable ? '' : 'cursor-not-allowed opacity-40'}`}>
                            <span className="font-semibold text-slate-800">{s.l}×{s.w}"</span>
                            <span className="tabular-nums text-slate-500">
                              {s.usable ? `≈ ${fmt.num(s.est_sheets)} sheets` : 'too small — waste'}
                            </span>
                          </button>
                        );
                      })}
                      <Checkbox label="Push to warehouse after cutting"
                        checked={lo.push}
                        onChange={e => setLo(v => {
                          if (!e.target.checked) return { push: false, strip: v.strip };
                          const first = ctx.leftover.strips.find(s => s.usable);
                          return { push: true, strip: v.strip || (first ? { l: first.l, w: first.w } : null) };
                        })} />
                      {lo.push && !lo.strip && <p className="text-[10px] text-amber-600">Pick which strip to keep.</p>}
                    </div>
                  </Card>
                )}
```

Guard in `savePlan`/`onLock`: if `lo.push && !lo.strip`, toast an error and return before POSTing.

- [ ] **Step 4: Verify in the preview.** Start the client dev server (preview tools), open Planning → engine on a sized line with an odd board: the Leftover card lists strips (unusable ones greyed), selecting one + toggling push then Lock shows the toast, reopening the engine shows the saved selection.

- [ ] **Step 5: Board-switch reset check.** In the engine, switch the board via Warehouse — the Leftover card recomputes (new ctx) and the push toggle resets to off.

---

### Task 12: Inventory Leftovers + Aging tabs, age chips everywhere

**Files:**
- Modify: `client/src/components/ui.jsx` — add `AgeChip`
- Modify: `client/src/pages/Inventory.jsx`
- Modify: `client/src/pages/FinishedGoods.jsx` — age chip on the lots table

- [ ] **Step 1: `AgeChip` in ui.jsx** (export alongside the other kit components):

```jsx
// Stock aging chip — 0–30 green · 31–60 amber · 61–90 orange · 90+ red.
export function AgeChip({ date, days }) {
  const d = days ?? Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 86400000));
  const cls = d <= 30 ? 'bg-emerald-50 text-emerald-700'
    : d <= 60 ? 'bg-amber-50 text-amber-700'
    : d <= 90 ? 'bg-orange-50 text-orange-700'
    : 'bg-red-50 text-red-700';
  return <span className={`inline-block rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums ${cls}`}>{d}d</span>;
}
```

- [ ] **Step 2: Inventory.jsx — data + tabs.** Add `AgeChip` to the ui.jsx import. New state `const [aging, setAging] = useState(null);` and `const [leftovers, setLeftovers] = useState(null);` plus `const [agingFilter, setAgingFilter] = useState('all');` — load both in `load()`:

```js
    api.get('/inventory/aging').then(setAging);
    api.get('/inventory/leftovers').then(setLeftovers);
```

Extend the Tabs array:

```js
        { key: 'leftovers', label: 'Leftovers', count: leftovers?.masters.filter(m => m.available > 0).length || 0 },
        { key: 'aging', label: 'Aging' },
```

- [ ] **Step 3: Leftovers tab** (after the `moves` tab block):

```jsx
      {tab === 'leftovers' && (
        <div className="space-y-4">
          <DataTable
            columns={[
              { key: 'code', label: 'Code', render: m => <span className="font-mono text-xs font-semibold">{m.code}</span> },
              { key: 'name', label: 'Leftover', render: m => (<div><div className="font-semibold">{m.name}</div><div className="text-xs text-gray-400">from {m.source_name || '—'}</div></div>) },
              { key: 'size', label: 'Strip Size', render: m => <span className="tabular-nums">{m.sheet_l}×{m.sheet_w}"</span> },
              { key: 'available', label: 'Available', align: 'right', render: m => <span className="font-bold tabular-nums">{fmt.num(m.available)} sheets</span> },
            ]}
            rows={leftovers?.masters || []} empty="No leftover stock banked yet — plan a job on an odd board and push its offcut here" />
          <div>
            <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-400">Lots — oldest first</h3>
            <DataTable
              columns={[
                { key: 'batch_no', label: 'Lot', render: b => <span className="font-mono text-xs font-semibold">{b.batch_no}</span> },
                { key: 'material_name', label: 'Leftover' },
                { key: 'source', label: 'From Job', render: b => <span className="text-xs text-gray-500">{b.batch_no.startsWith('LO-') ? b.batch_no.slice(3) : '—'}</span> },
                { key: 'qty', label: 'Sheets', align: 'right', render: b => fmt.num(b.qty) },
                { key: 'age', label: 'Age', render: b => <AgeChip days={b.age_days} /> },
                { key: 'created_at', label: 'Banked On', render: b => fmt.date(b.created_at) },
              ]}
              rows={leftovers?.lots || []} empty="No lots" />
          </div>
        </div>
      )}
```

- [ ] **Step 4: Aging tab:**

```jsx
      {tab === 'aging' && aging && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {['0-30', '31-60', '61-90', '90+'].map(k => (
              <div key={k} className="glass rounded-2xl p-4">
                <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">{k} days</div>
                <div className="mt-1 text-xl font-extrabold tabular-nums">{(aging.summary.raw[k]?.count || 0) + (aging.summary.fg[k]?.count || 0)}</div>
                <div className="text-[11px] text-slate-500">
                  {fmt.num(aging.summary.raw[k]?.qty || 0)} sheets · {fmt.num(aging.summary.fg[k]?.qty || 0)} FG pcs
                </div>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2 text-xs">
            {[['all', 'All'], ['raw', 'Raw Material'], ['fg', 'Finished Goods'], ['lo', 'Leftovers']].map(([k, label]) => (
              <button key={k} type="button" onClick={() => setAgingFilter(k)}
                className={`rounded-full px-3 py-1 font-semibold ${agingFilter === k ? 'bg-[#007AFF] text-white' : 'bg-slate-100 text-slate-600'}`}>{label}</button>
            ))}
          </div>
          <DataTable
            columns={[
              { key: 'what', label: 'Item', render: r0 => (<div><div className="font-semibold">{r0.material_name || r0.product_name}</div><div className="font-mono text-xs text-gray-400">{r0.batch_no || r0.lot_number}</div></div>) },
              { key: 'kind', label: 'Type', render: r0 => <span className="text-xs capitalize text-gray-500">{r0.lot_number ? 'FG lot' : r0.leftover ? 'leftover' : 'raw'}</span> },
              { key: 'qty', label: 'Qty', align: 'right', render: r0 => fmt.num(r0.qty) },
              { key: 'age', label: 'Age', render: r0 => <AgeChip days={r0.age_days} /> },
              { key: 'created_at', label: 'Since', render: r0 => fmt.date(r0.created_at) },
            ]}
            rows={[...aging.raw.filter(r0 => agingFilter === 'all' || (agingFilter === 'raw' && !r0.leftover) || (agingFilter === 'lo' && r0.leftover)),
                   ...(agingFilter === 'all' || agingFilter === 'fg' ? aging.fg : [])]
              .sort((a, b) => b.age_days - a.age_days)}
            empty="Nothing in stock" />
        </div>
      )}
```

(Note: `aging.raw` should be excluded entirely when `agingFilter === 'fg'` — the filter expression above already does this because both `raw`/`lo` predicates fail; double-check the boolean when implementing.)

- [ ] **Step 5: Inline chips.** RM Batches tab — add after the `created_at` column: `{ key: 'age', label: 'Age', render: b => b.status === 'available' ? <AgeChip date={b.created_at} /> : null },`
FinishedGoods.jsx — find the lots DataTable (grep `lot_number`), import `AgeChip` from `../components/ui.jsx`, add the same column with `date={l.created_at}`.

- [ ] **Step 6: Verify in the preview.** Inventory → Leftovers shows the banked strip with its LO code, source job and green age chip; Aging shows the four bucket cards and the combined oldest-first table; filters flip between raw/FG/leftovers; RM Batches and Finished Goods rows show age chips. Screenshot for Anik.

---

### Task 13: Full suite + regression sweep

**Files:** none (verification only)

- [ ] **Step 1: Run the whole new suite twice** (second run proves idempotency/dedup):

Run: `node "$SCRATCHPAD/uat-leftover.mjs"` × 2
Expected: all checks PASS both times; the second run's task-6 section books a NEW jc (new line) or skips — either way `one LO batch created` per jc_number.

- [ ] **Step 2: Regression** — run the existing suites (they live in an earlier session's scratchpad; locate with `ls /private/tmp/claude-501/*/*/scratchpad/uat*.mjs` and copy next to the new one if needed):

Run: `node uat.mjs && node uat-billing.mjs && node uat-sections.mjs && node uat-mes.mjs && node uat-planning.mjs`
Expected: all green. Known acceptable delta: `uat-planning.mjs` smart-match "sorted by score desc" may fail if a fitting leftover now outranks a higher-scored fresh board (leftover-first is deliberate). If it fails for exactly that reason, report it to Anik — do not weaken the leftover-first rule.

- [ ] **Step 3: Handover summary for Anik** — what was built, the LO code convention, where the decision lives (Planning Engine card), where to see leftovers + aging (Inventory tabs), and the two documented limitations: stage adjustments don't retro-adjust a booked leftover (use Inventory → Adjustment), and leftovers can't be purchased (409 by design).
