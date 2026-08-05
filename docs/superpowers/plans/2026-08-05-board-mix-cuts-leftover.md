# Board Mix — dynamic cuts, leftover banking, honest yield Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-row editable cuts with per-row leftover banking on both mix screens, per-board cutting variance on the floor, and a ledger that reads truthfully against order quantity.

**Architecture:** All new math is pure and twinned (server `helpers.js`/`production-variance.js` ↔ client `lib/cutFit.js`), tested with `node --test` from `server/src/` — the established pattern (`board-mix.test.js` asserts twin parity). No DDL anywhere: chosen cuts live in the existing `job_board_mix.ups`; per-row leftover extends the existing `order_lines.leftover_plan` JSON (v2 shape); merge-run banking is recorded by the batches themselves. **Task order is a safety device: the server 409 that today refuses differing cuts is repealed only in Task 5, after Tasks 2–4 make the floor able to handle what the repeal permits.**

**Tech Stack:** Node 22 + Express + pg, React 18 + Vite + Tailwind, `node --test`.

**Spec:** `docs/superpowers/specs/2026-08-05-board-mix-cuts-leftover-design.md`

---

## A note on commits

Standing session rule: no `git commit`, no push, no deploy, no prod migration.
Every commit step the writing-plans skill mandates is **deliberately omitted**
and replaced by a verification checkpoint. Work stays on branch
`shortage-panel`'s worktree at
`/Users/anikdua/.config/superpowers/worktrees/ci-erp/live-preview`.

## Baseline

```bash
cd "/Users/anikdua/.config/superpowers/worktrees/ci-erp/live-preview" && npm test -w server
```
Measured 2026-08-05: `# pass 1084`, `# fail 0`. Client builds clean.

## File structure

| File | Responsibility |
|---|---|
| `server/src/helpers.js` | **Modify.** Add `chosenStrips` + `chosenCutsValid` beside `leftoverStrips`; extend `unbankPlanningLeftover` sweep; add `bankRunLeftover`. |
| `client/src/lib/cutFit.js` | **Modify.** Client twins `chosenStrips` + `chosenCutsValid`. |
| `server/src/chosen-strips.test.js` | **Create.** Twin-parity + geometry tests. |
| `server/src/production-variance.js` | **Modify.** Add `mixCuttingVariance` beside `cuttingVariance`. |
| `server/src/production-variance.test.js` | **Modify.** Per-board cases. |
| `server/src/routes/production.js` | **Modify.** Cutting completion: per-board children entry, per-board true-up, per-row leftover confirm; merge-run confirm. |
| `server/src/routes/orders.js` | **Modify.** Plan-save: chosen cuts validation, 409 repeal (Task 5 only), leftover v2 banking; ctx candidates carry dims+max. |
| `server/src/routes/gangs.js` | **Modify.** Merge-run lock: chosen cuts, run banking, batch-seeded toggles. |
| `client/src/components/BoardMix.jsx` | **Modify.** Two-line rows, editable cuts, both-unit ledger, leftover toggle. |
| `client/src/pages/Planning.jsx` | **Modify.** Payload wiring both screens; client repeal of `gangMixOk` ups block. |
| Consumer files (Task 10 table) | **Modify.** Mix-aware expected math + displays. |

---

### Task 1: `chosenStrips` + `chosenCutsValid` — pure twins

The strip geometry for "take k of max, bank the rest". Rules from the spec:
k = max on a plain-grid fit banks exactly what `leftoverStrips` banks today;
k = max on a mixed/area fit banks nothing (the remainder bought the extra cut);
k below the plain-grid count uses grid layout at whole-column boundaries; <3"
is waste; strips normalised `{l: max, w: min}`.

**Files:**
- Modify: `server/src/helpers.js` (beside `leftoverStrips`)
- Modify: `client/src/lib/cutFit.js`
- Test: `server/src/chosen-strips.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/src/chosen-strips.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chosenStrips, chosenCutsValid, leftoverStrips } from './helpers.js';
import * as client from '../../client/src/lib/cutFit.js';

// Anik's own case: child 12.66×23 from a 24×38 board. Grid = 3×1 (three
// across the 38, one across the 24). Take 1, bank the tail.
const board = { sheet_l: 38, sheet_w: 24 };
const child = { child_l: 12.66, child_w: 23 };

test('k = max on a plain grid banks exactly what leftoverStrips banks', () => {
  assert.deepEqual(chosenStrips(board, child, 3), leftoverStrips(board, child));
});

test('take 1 of 3 — the un-cut tail plus the under-row strip', () => {
  const s = chosenStrips(board, child, 1);
  // tail: (38 − 1×12.66) × 24 = 25.34×24 (usable); under-row: 12.66 × (24−23) = 1" (waste, dropped by w>0.05? kept but unusable)
  assert.equal(s.length, 2);
  assert.deepEqual(s[0], { l: 25.34, w: 24, usable: true, strips_per_parent: 1 });
  assert.equal(s[1].usable, false); // 12.66×1 — under 3", waste not stock
});

test('take 2 of 3 — smaller tail, still clean', () => {
  const s = chosenStrips(board, child, 2);
  assert.deepEqual(s[0], { l: 24, w: 12.68, usable: true, strips_per_parent: 1 });
});

test('multi-row grid: k must sit on a whole-column boundary', () => {
  const b2 = { sheet_l: 40, sheet_w: 30 }, c2 = { child_l: 10, child_w: 14 };
  // grid: 4 along 40 (10s) × 2 along 30 (14s) = 8
  assert.equal(chosenCutsValid(b2, c2, 8).ok, true);
  assert.equal(chosenCutsValid(b2, c2, 6).ok, true);   // 3 columns × 2
  assert.equal(chosenCutsValid(b2, c2, 5).ok, false);  // ragged — not clean rectangles
  const s = chosenStrips(b2, c2, 6);
  // tail: (40 − 3×10) × 30 = 30×10; bottom: 30 × (30 − 2×14) = 30×2 (waste)
  assert.deepEqual(s[0], { l: 30, w: 10, usable: true, strips_per_parent: 1 });
});

test('k above max is invalid, k below 1 is invalid', () => {
  assert.equal(chosenCutsValid(board, child, 4).ok, false);
  assert.equal(chosenCutsValid(board, child, 0).ok, false);
  assert.equal(chosenCutsValid(board, child, 3).max, 3);
});

test('a non-grid fit at its own max banks exactly what leftoverStrips banks: nothing', () => {
  // Fixture rule: take a KNOWN area/mixed-reach pair from cut-sizing.test.js
  // (that file pins the plant's quarter-sheet area rule with real dims — do
  // NOT invent dims; an invented pair whose area ratio floors to 4 fails
  // against correct code). Assert its basis first so the fixture can never
  // silently degrade to a plain grid, then assert max-parity and that
  // dropping below the plain-grid count banks a real strip.
  const { board: b3, child: c3 } = FIXTURE_FROM_CUT_SIZING_TESTS; // resolve while writing this test
  const fit = childFit(b3, c3);
  assert.notEqual(fit.basis, 'grid');
  assert.deepEqual(chosenStrips(b3, c3, fit.count), leftoverStrips(b3, c3)); // both empty
  assert.equal(chosenStrips(b3, c3, fit.count).length, 0);
});

test('unsized board answers empty/invalid rather than throwing', () => {
  assert.deepEqual(chosenStrips({}, child, 1), []);
  assert.equal(chosenCutsValid({}, child, 1).ok, false);
});

test('client twin produces identical output', () => {
  for (const k of [1, 2, 3]) {
    assert.deepEqual(
      client.chosenStrips(38, 24, 12.66, 23, k),
      chosenStrips(board, child, k));
  }
  assert.deepEqual(client.chosenCutsValid(38, 24, 12.66, 23, 2),
    chosenCutsValid(board, child, 2));
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd "/Users/anikdua/.config/superpowers/worktrees/ci-erp/live-preview" && node --test server/src/chosen-strips.test.js
```
Expected: FAIL — `chosenStrips` is not exported.

- [ ] **Step 3: Implement in `server/src/helpers.js`**, directly below `leftoverStrips`:

```js
// "Take k of max, bank the rest" — the per-row generalisation of
// leftoverStrips. Children fill whole COLUMNS of the plain grid (c = k/nW),
// so remainders stay the two clean rectangles a guillotine actually leaves:
// the un-cut tail along the length, and the strip under the grid. k at the
// fit's own max defers to leftoverStrips (identical answer on a grid fit;
// nothing on a mixed/area fit, whose remainder bought the extra cut).
export function chosenCutsValid(parent, child, k) {
  const fit = childFit(parent, child);
  if (!fit.sized || fit.count <= 0) return { ok: false, max: 0, why: 'This board and child size cut nothing' };
  const kk = Math.round(+k || 0);
  if (kk === fit.count) return { ok: true, max: fit.count, grid: true };
  const PL = +parent.sheet_l, PW = +parent.sheet_w;
  const [cl, cw] = fit.orientation === 'rotated'
    ? [+child.child_w, +child.child_l] : [+child.child_l, +child.child_w];
  const EPS = 1e-6;
  const nL = Math.floor(PL / cl + EPS), nW = Math.floor(PW / cw + EPS);
  if (!(kk >= 1) || kk > nL * nW)
    return { ok: false, max: fit.count, why: `Cuts must be between 1 and ${fit.count}` };
  if (kk % nW !== 0)
    return { ok: false, max: fit.count, why: `On this board cuts step by ${nW} — a ragged take leaves no clean strip` };
  return { ok: true, max: fit.count, grid: true };
}

export function chosenStrips(parent, child, k) {
  const v = chosenCutsValid(parent, child, k);
  if (!v.ok) return [];
  const fit = childFit(parent, child);
  if (Math.round(+k) === fit.count) return leftoverStrips(parent, child);
  const PL = +parent.sheet_l, PW = +parent.sheet_w;
  const [cl, cw] = fit.orientation === 'rotated'
    ? [+child.child_w, +child.child_l] : [+child.child_l, +child.child_w];
  const EPS = 1e-6;
  const nW = Math.floor(PW / cw + EPS);
  const c = Math.round(+k) / nW;
  const raw = [
    { l: +(PL - c * cl).toFixed(2), w: PW },
    { l: +(c * cl).toFixed(2), w: +(PW - nW * cw).toFixed(2) },
  ];
  return raw
    .map(s => ({ l: Math.max(s.l, s.w), w: Math.min(s.l, s.w) }))
    .filter(s => s.w > 0.05)
    .map(s => ({ ...s, usable: s.w >= 3, strips_per_parent: 1 }));
}
```

- [ ] **Step 4: Client twin in `client/src/lib/cutFit.js`** — same math over the
flat-arg convention `clientFit`/`clientStrips` already set there:

```js
export function chosenCutsValid(parentL, parentW, childL, childW, k) { /* twin */ }
export function chosenStrips(parentL, parentW, childL, childW, k) { /* twin */ }
```

Reuse that file's existing fit internals; outputs byte-identical to the server
twin — the parity cases in Step 1 are the contract. Note the test imports
`childFit` from helpers for the fixture-basis assertion — extend the import
line accordingly, and merge Task 2's later import into the existing top-of-file
imports rather than adding a mid-file one.

- [ ] **Step 5: Run the test — PASS; then the whole suite**

```bash
cd "/Users/anikdua/.config/superpowers/worktrees/ci-erp/live-preview" && node --test server/src/chosen-strips.test.js && npm test -w server
```
Expected: new file green; suite = 1084 + the new count, `# fail 0`. If a
geometry expectation in Step 1 disagrees with the implementation by small
decimals, fix the TEST only if hand-derivation proves the implementation right
— show the derivation in your report.

---

### Task 2: `mixCuttingVariance` — per-board variance math

**Files:**
- Modify: `server/src/production-variance.js`
- Test: `server/src/production-variance.test.js` (extend)

- [ ] **Step 1: Failing tests** — append to `production-variance.test.js`:

```js
import { mixCuttingVariance } from './production-variance.js';

test('two boards, one over-cut: variance lands on the right board only', () => {
  const v = mixCuttingVariance({ rows: [
    { material_id: 1, issued: 900, cuts: 3, children: 2700 },
    { material_id: 2, issued: 417, cuts: 1, children: 420 },
  ]});
  assert.equal(v.rows[0].parentDelta, 0);
  assert.equal(v.rows[1].actualParents, 420);
  assert.equal(v.rows[1].parentDelta, 3);
  assert.equal(v.isVariance, true);
  assert.equal(v.parentDelta, 3);
  assert.equal(v.actualChildren, 3120);
});

test('clean cut on every board is no variance', () => {
  const v = mixCuttingVariance({ rows: [
    { material_id: 1, issued: 10, cuts: 3, children: 30 },
    { material_id: 2, issued: 5, cuts: 2, children: 10 },
  ]});
  assert.equal(v.isVariance, false);
});

test('empty rows answer zeros rather than throwing', () => {
  const v = mixCuttingVariance({});
  assert.equal(v.isVariance, false);
  assert.equal(v.rows.length, 0);
});
```

- [ ] **Step 2: Verify FAIL, then implement** in `production-variance.js`:

```js
// Per-board cutting variance for mixed jobs. The operator reports children
// PER BOARD; each pile is judged against its own chosen cuts and trues up its
// own board's stock. cuttingVariance above stays byte-identical for the
// single-board path.
export function mixCuttingVariance({ rows = [] } = {}) {
  const out = rows.map(r => {
    const cpp = Math.max(1, +r.cuts || 1);
    const plannedParents = Math.max(0, Math.round(+r.issued || 0));
    const actualChildren = Math.max(0, Math.round(+r.children || 0));
    const actualParents = Math.round(actualChildren / cpp);
    return { material_id: r.material_id, cpp, plannedParents, actualParents,
             parentDelta: actualParents - plannedParents,
             plannedChildren: plannedParents * cpp, actualChildren };
  });
  const sum = k => out.reduce((s, r) => s + r[k], 0);
  return { rows: out,
           plannedParents: sum('plannedParents'), actualParents: sum('actualParents'),
           plannedChildren: sum('plannedChildren'), actualChildren: sum('actualChildren'),
           parentDelta: sum('actualParents') - sum('plannedParents'),
           isVariance: out.some(r => r.parentDelta !== 0) };
}
```

- [ ] **Step 3: PASS + whole suite green.** Same commands as Task 1 Step 5.

---

### Task 3: Cutting completion — per-board entry, true-up, and confirm

The floor half. Until this lands the 409 stays, so nothing mixed can reach it.

**Files:**
- Modify: `server/src/routes/production.js` (completion block, ~1770–1990)
- Modify: `server/src/helpers.js` (`unbankPlanningLeftover` sweep)

- [ ] **Step 1: Per-board variance branch.** In the `st.stage === 'cutting'`
block (production.js:1773), before the existing single-board call: load the
line's issued mix (`mixFor` on `phase='issued'`, falling back to `'plan'` rows
when issue recorded no per-board split). If the mix has **>1 board**, require
`req.body.cut_children` = `[{material_id, children}]` covering every issued
board, 400 naming any missing board; require Σ children = `qty_out + qty_scrap`
(409 with both numbers on mismatch); run `mixCuttingVariance` with each row's
issued sheets and chosen cuts. Shared `variance_reason` required exactly as
today when `isVariance`. A one-board mix falls through to the existing
`cuttingVariance` with that board's chosen cuts in place of
`jc.children_per_parent`. No mix at all → byte-identical legacy path.

- [ ] **Step 2: Per-board true-up.** In the variance write-block (~1887): for
each variant row, `adjustBoardStock(row.material_id, row.parentDelta, …)` with
the per-board note; one `cutting_discrepancies` INSERT per variant board (the
table already carries `board_material_id` per row — reuse the existing column
list, `cpp` = that board's cuts); `job_cards.sheets_issued` and
`job_stages.qty_in` become Σ actualParents; and each `job_board_mix`
`phase='issued'` row's `sheets` is rewritten to its own board's actualParents
so downstream board math reads the truth. Audit lines per board, mirroring the
existing wording.

- [ ] **Step 3: Per-row leftover confirm.** In the leftover block (~1935): after
the legacy single-plan branch, add the v2 branch — when
`plan?.version === 2 && Array.isArray(plan.rows)`, loop rows: planNo
`LO-PLAN-<order_line_id>-<material_id>`, confirmedNo
`LO-<jc_number>-<material_id>`, `actualQty = strips_per_parent × that board's
actualParents` (from Step 2's rows; absent variance = its issued sheets).
True-up/rename exactly as the legacy branch does (delta movement, rename,
status). The legacy branch's keys and behaviour stay byte-identical.

- [ ] **Step 4: Widen the unbank sweep.** `unbankPlanningLeftover` in helpers.js
currently reads one exact batch. It must also sweep v2 batches:

```js
const batches = await qc(
  `SELECT * FROM stock_batches WHERE batch_no=$1 OR batch_no LIKE $2`,
  [`LO-PLAN-${lineId}`, `LO-PLAN-${lineId}-%`]);
```
looping the existing reversal per batch. The dash in the LIKE pattern means
`LO-PLAN-12-%` can never match `LO-PLAN-123`.

- [ ] **Step 5: Checkpoint** — suite green, and grep proves the legacy keys
survived:

```bash
cd "/Users/anikdua/.config/superpowers/worktrees/ci-erp/live-preview" && npm test -w server && grep -n "LO-PLAN-\${" server/src/routes/production.js server/src/helpers.js | head
```

---

### Task 4: Plan-save — leftover v2 accepted and banked

**Files:**
- Modify: `server/src/routes/orders.js` (plan-save ~1267–1310, mix loop ~1330–1400; ctx ~1560–1780)

- [ ] **Step 1: Accept the v2 payload.** Plan-save body gains optional
`mix_leftovers: [{material_id, bank}]` alongside `mix`. After the mix rows are
validated: for each row with `bank: true`, compute the row's parent (planned
row → `effectiveParent(eff, board)`; substitute → the material's own sheet —
the same asymmetry the mix loop already documents), `chosenStrips(parent, eff,
row.ups)`, take the usable strips; 409 if none is usable ("Strip X×Y″ is under
3″ — waste, not stock", reusing the existing wording). Build
`leftover_plan = { version: 2, rows: [...] }` with `cuts`, `strip`,
`est_sheets = row.sheets`, `strips_per_parent`. A no-mix save keeps the legacy
single-board branch byte-identical.

- [ ] **Step 2: Bank per row at lock.** Where the legacy path calls
`bankPlanningLeftover(line, board, strip, spp, parentSheets, …)`, the v2 path
loops its rows calling the same helper with batchNo overridden — add an
optional `batchNo` last param to `bankPlanningLeftover` defaulting to the
legacy `LO-PLAN-<line.id>` so existing call sites change nothing — passing
`LO-PLAN-<line.id>-<material_id>` per row. Re-plan reconciliation and
`unbankPlanningLeftover` (Task 3 Step 4) already handle deltas and sweeps.

- [ ] **Step 3: Ctx carries what the client needs.** The planning context's
`mix` object (orders.js ~1560–1780) gains per-candidate `sheet_l`, `sheet_w`,
`max_cuts` (its `childFit(...).count`), and `planned_parent_l/planned_parent_w`
(the `effectiveParent` dims) — the client strip preview and the cuts cap need
them. Pure additions; nothing existing renamed.

- [ ] **Step 4: Checkpoint** — suite green; build green.

---

### Task 5: Plan-save — chosen cuts, and the repeal

Only now is the floor ready for what this permits.

**Files:**
- Modify: `server/src/routes/orders.js` (mix loop)

- [ ] **Step 1: Accept chosen cuts.** In the mix loop, `raw.ups` becomes the
chosen value: validate with `chosenCutsValid(rowParent, eff, raw.ups)` (same
per-row parent rule as Task 4), 409 with its `why` on failure; default to the
board's max when absent. `covers = rowCovers({ sheets, ups: chosen,
plannedUps })` — `plannedUps` stays the plan's own fit count, the unit the
requirement was derived in.

- [ ] **Step 2: The repeal.** Delete the `flags.ups_differ` 409 at
orders.js:1358 and its comment; `substitutionFlags` still runs (grade
enforcement and severity labelling stay — severity is judged on the board's
NATURAL fit, chosen cuts don't change what the board is). Replace with a
comment recording the decision: differing cuts are planner intent now, the
plate never changed (child is identical across rows), variance is per-board
since Task 3, decided by Anik 2026-08-05.

- [ ] **Step 3: Tests.** Extend `server/src/board-mix.test.js`'s route-adjacent
cases if any assert the 409; otherwise add to `chosen-strips.test.js` a case
proving `chosenCutsValid` rejects over-max (the route's guard is that
function). Run the suite — any test that asserted the old 409 gets updated to
assert the new acceptance, named for the repeal.

- [ ] **Step 4: Checkpoint** — suite green.

---

### Task 6: BoardMix — two-line rows, editable cuts, both-unit ledger, leftover toggle

**Files:**
- Modify: `client/src/components/BoardMix.jsx`

- [ ] **Step 1: New props.** `BoardMix({ ctx, required, rows, onChange, printUps,
orderQty, leftovers, onLeftovers })` — `printUps` = the product's images per
print sheet, `orderQty` = order cartons, `leftovers` = `{[material_id]: bool}`,
`onLeftovers` its setter. All optional with safe defaults so the gang call
site compiles before Task 9 wires it.

- [ ] **Step 2: Two-line row.** Line 1: full-width `Select` (no more 60px
squeeze) + PLANNED chip + remove ×. Line 2, grid
`[repeat: cuts 72px · sheets 96px · child-sheets 84px · cartons 96px]`:

- **Cuts** — `Input type="number"` min 1, max = candidate `max_cuts` (planned
  row: `mix.planned_ups`), value `r.ups`, `onChange` through `set(i, { ups })`
  clamped client-side; sub-caption `of {max}`.
- **Sheets** — the existing input.
- **Child sheets** — derived `sheets × ups`, the honest name for what the old
  "Cartons" column showed.
- **Cartons** — derived `sheets × ups × printUps`, `title` showing the
  arithmetic.

- [ ] **Step 3: Leftover chip.** When `r.ups < max` and the strip preview
(client `chosenCutsValid`/`chosenStrips` over the ctx dims from Task 4 Step 3)
has a usable strip: a toggle chip on line 2's right — `banks {sheets} ×
{l}×{w}″` when on, `strip to waste` when off — writing through `onLeftovers`.
Ragged k (validator `why`) shows the reason inline and no chip.

- [ ] **Step 4: The differing-cuts note.** Replace the red `ups_differ` block
("needs its own plate, so it can't be saved") with a calm slate note only when
a SUBSTITUTE's natural max differs from the plan's: `Cuts {max} up natively
against the plan's {plannedUps} — covers convert accordingly.` The save is no
longer blocked; say what is true instead.

- [ ] **Step 5: Ledger footer.** Row 1 totals: child sheets Σ, cartons Σ. Row 2:
required child sheets (existing `required × plannedUps`) and — when `orderQty`
present — `≈ {totalCartons} cartons vs order {orderQty}` with over/under
tinted amber when short of order, emerald at/above. All rounded, EPS
comparisons.

- [ ] **Step 6: Checkpoint** — component compiles standalone (nothing new
imports yet on the gang side):

```bash
cd "/Users/anikdua/.config/superpowers/worktrees/ci-erp/live-preview/client" && ../node_modules/.bin/esbuild src/components/BoardMix.jsx --bundle --format=esm --jsx=automatic --outfile=/dev/null && cd .. && npm run build -w client
```

---

### Task 7: Wire the single-line engine

**Files:**
- Modify: `client/src/pages/Planning.jsx` (single-line BoardMix call site; plan-save payload)
- Investigate/fix: the parent-exceeds-board oddity

- [ ] **Step 1: Props.** The single-line `<BoardMix …>` call site gains
`printUps={+eff?.ups || +planLine?.ups || 1}` (verify the real field name for
images-per-print-sheet on the effective line — the cut plan section renders it
as "Ups / print sheet"; reuse its exact source), `orderQty={netProduceQty
figure the page already shows}` (again: reuse the page's own variable, do not
recompute), `leftovers` state + setter (new `useState({})`, reset with
`mixRows` wherever they reset).

- [ ] **Step 2: Payload.** Plan-save call gains
`mix_leftovers: Object.entries(leftovers).filter(([,v]) => v).map(([id]) =>
({ material_id: +id, bank: true }))` and each mix row sends its chosen `ups`.

- [ ] **Step 3: The screenshot oddity.** Reproduce: a product whose
`parent_l/parent_w` exceeds its board's `sheet_l/sheet_w` renders "Parent
25×38 trimmed from board 23×26.5″". Read `effectiveParent` (helpers.js:131)
and the cut-plan hints in Planning.jsx. Decide from what you find: if
plan-save accepts a parent larger than the board, add the 409 (`Parent
{L}×{W}″ cannot be trimmed from board {l}×{w}″`) in plan-save where
`effectiveParent` resolves; if it is only a stale hint, fix the hint. Report
which it was with file:line evidence.

- [ ] **Step 4: Checkpoint** — build green; suite green.

---

### Task 8: Smart Match — consented seeding into the mix

Smart Match's `Use` (Planning.jsx:2713) silently swaps the plan's board via
`pickBoard` (:966). Per the spec addition: same-grade matches seed the mix
behind a consent popup; cross-grade matches keep the swap behind their own
confirm. Single-line engine only — the run view has no Smart Match.

**Files:**
- Create: `server/src/smart-seed.test.js`
- Modify: `client/src/lib/boardMix.js` (pure seed math)
- Modify: `client/src/pages/Planning.jsx` (modals + Use wiring)

- [ ] **Step 1: Failing test.** Create `server/src/smart-seed.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { smartSeedRow } from '../../client/src/lib/boardMix.js';

test('converts the shortfall by cuts ratio and caps at available stock', () => {
  // Short 1,000 planned-parents; match cuts 4 vs plan 2 → needs 500 of it; 800 free.
  const s = smartSeedRow({ balanceParent: 1000, plannedUps: 2, cuts: 4, available: 800 });
  assert.equal(s.sheets, 500);
  assert.equal(s.coversParent, 1000);
  assert.equal(s.pendingAfter, 0);
});

test('thin stock covers partially and names the pending remainder', () => {
  const s = smartSeedRow({ balanceParent: 1000, plannedUps: 2, cuts: 2, available: 350 });
  assert.equal(s.sheets, 350);
  assert.equal(s.coversParent, 350);
  assert.equal(s.pendingAfter, 650);
});

test('rounds up the sheet need — a fractional sheet is a whole sheet', () => {
  const s = smartSeedRow({ balanceParent: 1001, plannedUps: 2, cuts: 4, available: 9999 });
  assert.equal(s.sheets, 501);   // ceil(1001 × 2 / 4)
  assert.ok(s.pendingAfter === 0);
});

test('zero/absent availability seeds nothing rather than a phantom row', () => {
  const s = smartSeedRow({ balanceParent: 500, plannedUps: 2, cuts: 2, available: 0 });
  assert.equal(s.sheets, 0);
  assert.equal(s.pendingAfter, 500);
});

test('guards its preconditions like rowCovers does', () => {
  assert.throws(() => smartSeedRow({ balanceParent: 10, plannedUps: 0, cuts: 2, available: 5 }), /plannedUps/);
  assert.throws(() => smartSeedRow({ balanceParent: 10, plannedUps: 2, cuts: 0, available: 5 }), /cuts/);
});
```

- [ ] **Step 2: FAIL, then implement** in `client/src/lib/boardMix.js` beside
`rowCovers` (client-only — the server recomputes `covers` at save, so no twin):

```js
// What one Smart Match row would contribute if adopted into the mix: the
// remaining shortfall converted into ITS sheets by the cuts ratio, capped at
// what the shelf actually holds — Smart Match's whole point is REAL stock, so
// a seed beyond availability would just trade a shortage for an amber warning.
export function smartSeedRow({ balanceParent, plannedUps, cuts, available }) {
  const p = num(plannedUps), u = num(cuts);
  if (!(p > 0)) throw new Error(`smart-seed: plannedUps must be greater than zero (got ${plannedUps})`);
  if (!(u > 0)) throw new Error(`smart-seed: cuts must be greater than zero (got ${cuts})`);
  const need = Math.max(0, num(balanceParent));
  const wanted = Math.ceil(need * p / u - EPS);
  const sheets = Math.max(0, Math.min(wanted, Math.floor(num(available))));
  const coversParent = sheets * u / p;
  return { sheets, coversParent, pendingAfter: Math.max(0, +(need - coversParent).toFixed(2)) };
}
```

- [ ] **Step 3: PASS + suite.** Standard commands.

- [ ] **Step 4: The two confirms in Planning.jsx.** New state
`smartConfirm` (`{ match, kind: 'mix' | 'swap' } | null`). The Use button
(:2713) stops calling `pickBoard` directly:

```jsx
onClick={() => {
  const sameGrade = parseBoardName(m.name)?.grade?.trim().toLowerCase()
    === parseBoardName(boardSel?.name)?.grade?.trim().toLowerCase();
  setSmartConfirm({ match: m, kind: sameGrade ? 'mix' : 'swap' });
}}
```

(`parseBoardName` from `../lib/boardCode.js` — already imported by BoardMix;
add the import here. An unparseable name compares as not-same → swap, matching
the mix's own blocked rule.)

Two `Modal`s beside the Smart Match block, in the established idiom
(`Not now` dismiss, disabled-while-`busy` untouched):

**Mix seed** (`kind === 'mix'`) — the ledger Anik dictated, computed via
`smartSeedRow` with the current balance (`mixTotals(...).balance` when rows
exist, else `position.short`):

```jsx
<Modal open={smartConfirm?.kind === 'mix'} onClose={() => setSmartConfirm(null)}
  title="Use this board, as per Smart Match?"
  footer={<>
    <Button variant="secondary" onClick={() => setSmartConfirm(null)}>Not now</Button>
    <Button variant="primary" disabled={seed.sheets === 0 || alreadyInMix}
      onClick={confirmSmartSeed}>Add to the mix</Button>
  </>}>
  <div className="space-y-1.5 text-sm text-slate-600">
    <Row k="Master" v={`${boardSel?.name} — needs ${fmt.num(required)} parent sheets`} />
    <Row k="Using" v={`${m.name} — ${fmt.num(seed.sheets)} sheets at ${m.children_per_parent} cuts`} />
    <Row k="Covers" v={`${fmt.num(Math.round(seed.coversParent))} parent-equivalent`} />
    <Row k="Pending after" v={seed.pendingAfter > 0 ? `${fmt.num(Math.round(seed.pendingAfter))} still short` : 'fully covered'} />
  </div>
  {alreadyInMix && <p ...>Already in the mix — adjust its sheets on the left.</p>}
</Modal>
```

(`Row` = a tiny label/value line; `alreadyInMix` =
`mixRows.some(r => r.material_id === m.material_id)`. Resolve the exact match
field names from the smart payload — `smartmatch.js:86` shows
`children_per_parent`, `available`, `material_id`; verify, don't assume.)

**Swap confirm** (`kind === 'swap'`) — names both grades and the consequence,
then calls the untouched `pickBoard(m)`:
"Switches this plan's board to {name} ({grade} against the master's {grade}) —
the cut plan re-parents and you lock to confirm. It does not join the mix: a
different grade is the customer's spec, not a substitution."

- [ ] **Step 5: `confirmSmartSeed`.** Same shape as `seedCoverMix` — planned
row seeded first when `mixRows` is empty (`plannedSheets > 0` guard), then the
match as a substitute row (`ups: m.children_per_parent`, `sheets: seed.sheets`,
`reason: DEFAULT_MIX_REASON`, severity/flags from the ctx candidate when the
match is also a candidate, else computed via `substitutionFlags` client-side);
close the modal; toast `${m.name} added to the mix — ${pending text}`.

- [ ] **Step 6: Checkpoint.** Build + suite green; grep proves no remaining
bare `onClick={() => pickBoard(m)}` in the Smart Match block.

---

### Task 9: Merge runs

**Files:**
- Modify: `server/src/routes/gangs.js` (lock ~1040–1075; `gangMixContext`)
- Modify: `server/src/helpers.js` (`bankRunLeftover`)
- Modify: `client/src/pages/Planning.jsx` (run panel call site, `gangMixOk`)
- Modify: `server/src/routes/production.js` (merge-run leftover confirm)

- [ ] **Step 1: Kind gate.** Everything below applies only when
`gang_runs.kind === 'merge'`. A gang-kind run keeps derived cuts (the
`upsFor` recompute) and no banking; its panel shows the read-only cuts with a
one-line note ("A gang's cuts are per member — set by each child's own fit").

- [ ] **Step 2: Chosen cuts through the lock.** In the lock's split loop
(gangs.js:1052), for merge runs `upsFor` yields one value per board across
members; when the client sent a chosen `ups` on the run row, validate
`chosenCutsValid(materialSheet, memberChild, chosen)` and use it in place of
the natural fit for every member's split row and `covers`.

- [ ] **Step 3: `bankRunLeftover`.** New helper beside `bankPlanningLeftover`,
same reconciliation body, batchNo `LO-PLAN-RUN-<runId>-<materialId>`,
`ref_type 'gang_run'`, audit on `gang_run`. Called at lock per banked row
(run-level sheets). Unbank on run re-lock/unlock sweeps
`LO-PLAN-RUN-<runId>-%` the same way Task 3 Step 4 sweeps lines.

- [ ] **Step 4: Toggles seeded from batches.** `gangMixContext` returns
`leftover_batches: [{material_id, qty}]` from existing `LO-PLAN-RUN-<id>-%`
rows; the client seeds its toggle state from it (the batches ARE the record —
spec). Re-lock reconciles deltas; a toggled-off row reconciles to zero.

- [ ] **Step 5: Merge confirm at cutting.** In production.js's leftover block,
the gang guard (`!jcForLeftover?.order_line_id`) currently skips ALL gang
parents. Narrow it: resolve the JC's run; `kind='gang'` keeps the skip and its
comment; `kind='merge'` confirms `LO-PLAN-RUN-<run>-<mat>` →
`LO-<jc>-<mat>` with actual parents per board from Task 3's rows.

- [ ] **Step 5b: Merge-run completion variance (gap found by Task 3's
implementer).** Run cards have `order_line_id NULL`, so Task 3's mix loading
finds nothing and completion falls back to `jc.children_per_parent` — wrong
once a merge run carries chosen cuts. For `kind='merge'` job cards: aggregate
the run's members' `job_board_mix` issued rows per board (Σ sheets per
material, cuts identical across members by construction — assert it, 500 if
violated), and feed the same per-board variance + true-up + `cut_children`
entry contract Task 3 built for lines. `kind='gang'` cards stay wholly legacy.

- [ ] **Step 6: Client.** Run panel's `<BoardMix>` gains the same new props
(printUps from the run's product, orderQty = run total cartons); `gangMixOk`
(Planning.jsx:922–924) drops the `ups_differ` veto for merge runs — the same
repeal, client side.

- [ ] **Step 7: Checkpoint** — build + suite green.

---

### Task 10: Consumer sweep — every reader of `children_per_parent`

The rule: **mix active → derive per board; no mix → byte-identical.** The
enumeration, classified (verified by grep 2026-08-05):

| File:line | Class | Change |
|---|---|---|
| `production.js:1775` | derive | done in Task 3 |
| `floor.js:68,117,204,359` | payload | stage/JC payloads gain `mix_cuts: [{material_id, board_name, issued, cuts}]` when the line's mix has rows (one query, LEFT-joined; null otherwise) |
| `client/lib/received.js:30` | derive | `expectedOutputQty(row, stage, cpp, mixCuts?)` — cutting expected = Σ issued×cuts when `mixCuts` present; existing signature callers unchanged |
| `Production.jsx:263,604` · `Section.jsx:200,265` · `PressLineup.jsx:266` · `PrintPlanning.jsx:298,1539` | derive | pass the payload's `mix_cuts` through to `expectedOutputQty`; titles show the per-board breakdown. **Production.jsx also completes cutting** (its cpp use at :263 feeds entry) — it gets the same per-board children inputs as Floor.jsx below, or the server's `cut_children` 400 would be unsatisfiable from this screen |
| `Floor.jsx:185,202` | derive/display | cutting entry cpp per board (the per-board children entry UI — one input per issued board, sum shown live against the stage total, wired to `cut_children`); breakup lists each board |
| `JobCardPrint.jsx:48` | display | mix: replace the single yield line with per-pile instructions — `{board} — {sheets} parents × {cuts} cuts` plus `bank strip {l}×{w}″ ≈ {est}` per banked row (the cutter's actual orders) |
| `PrintPlanning.jsx:274,1612` | display | `mixed · N boards` with title breakdown when mix |
| `extrasheets.js:349` · `ExtraSheets.jsx:195,306,433` · `Section.jsx:1660` | planned-board rule | extra sheets are issued against the PLANNED board; its chosen cuts convert. One comment at each site records the rule |
| `boardUsed.js:118` | verify | `cut_layout?.count` already takes precedence — confirm `cut_layout` carries mix truth or extend it; report which |
| `smartmatch.js:86` · `helpers.js:1486` · `board-allocation.js:37` · `inventory.js:51` · `Planning.jsx:2716,3584` | untouched | candidate/self fits and comments — not job expectations |
| `helpers.js:1809,1928` · `gangs.js:1403` | untouched | JC creation keeps storing the planned board's cuts in the legacy column; the floor switches on mix presence, never on the column being absent |

- [ ] **Step 1** through **Step N**: one step per row of the table, in order,
running the suite after `received.js` (its tests exist: `opening-counter`,
received-related) and the client build after each page file.

- [ ] **Final step: the property.** `board-mix.test.js`'s no-mix PROPERTY test
still green, plus a fresh grep proving no consumer reads the legacy column for
a mixed expectation:

```bash
cd "/Users/anikdua/.config/superpowers/worktrees/ci-erp/live-preview" && npm test -w server && npm run build -w client
```

---

### Task 11: End-to-end verification on the writable sandbox

**Files:** none — verification only. Sandbox: `cierp_shortage` DB on the
embedded PG (launch config `ci-erp-shortage-writable`, ports 4925/5925,
`admin@motionci.com` / `verify-local-only`).

- [ ] **Step 1: Single line.** On the Azithro line (or any short line): add a
substitute row, set its cuts below max, watch the ledger (child sheets AND
cartons vs order), toggle the bank chip, lock. SQL-verify:
`LO-PLAN-<line>-<mat>` batch + `leftover_in` movement + leftover master with
correct dims; `job_board_mix.ups` = chosen; `covers` consistent.
- [ ] **Step 2: Re-plan reconciliation.** Change cuts, re-lock: batch qty
delta'd, not duplicated; toggle off, re-lock: reconciled to zero.
- [ ] **Step 3: Floor.** Issue the boards, complete cutting with per-board
children (one clean, one variant): shared reason demanded; one
`cutting_discrepancies` row for the variant board only; that board's stock
trued; `LO-PLAN-*` renamed `LO-<jc>-<mat>` with actual-qty true-up.
- [ ] **Step 4: Merge run.** Seed a merge run of the same product on two orders
(UAT pattern: seed the UAT its OWN board+batch), chosen cuts + bank at run
level, lock: `LO-PLAN-RUN-*` batches; reopen: toggles seeded from batches;
cutting confirm renames to `LO-<jc>-<mat>`.
- [ ] **Step 5: Gang-kind unchanged.** Open a gang-kind run: cuts read-only
with the note; no bank chips; lock unchanged.
- [ ] **Step 6: Legacy regression.** A no-mix job: plan, lock with the OLD
single-board leftover picker, complete cutting — every key still
`LO-PLAN-<line>` / `LO-<jc>`, single `cutting_discrepancies` shape, byte-identical.
- [ ] **Step 7: Final gate.**

```bash
cd "/Users/anikdua/.config/superpowers/worktrees/ci-erp/live-preview" && npm test -w server && npm run build -w client
```

Do **not** run `npm run verify` from the repo root — `--check` writes the
baseline and dirties every worktree sharing this repository.
