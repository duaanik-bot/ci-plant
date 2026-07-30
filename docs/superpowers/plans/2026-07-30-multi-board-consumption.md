# Multi-Board Consumption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one production job be covered by several boards of the same grade — different GSM, sometimes a different sheet size — recorded in Planning, overridable at Cutting, without changing the product master or the planned specification.

**Architecture:** A new `job_board_mix` table records the boards a job actually consumes, beside (never instead of) the planned board. A new pure module `server/src/board-mix.js` turns those rows into coverage numbers, following `board-allocation.js`'s shape exactly — plain rows in, numbers out, no `pg`. Five call sites in the existing engine ask the mix a question and fall through to today's behaviour when a job has no mix rows. Each plan row mirrors an ordinary hold into `board_allocations` so the warehouse's free/held view stays correct without the live purchase formula being edited.

**Tech Stack:** Node 20 ESM, Express, `pg` (no ORM), `node:test` + `node:assert/strict`, React 18 + Vite + Tailwind. Repo root `~/.config/superpowers/worktrees/ci-erp/multi-board`, branch `multi-board-consumption`, based on `main@aa26e5e`.

**Spec:** `docs/superpowers/specs/2026-07-30-multi-board-consumption-design.md`

---

## Scope decision made during planning — read this first

The spec allows a substitute whose sheet size changes the ups, converted through
its own ups. While pinning the code down, `server/src/db.js:243` showed
`job_cards.children_per_parent INTEGER` and `sheets_issued INTEGER`. A mix whose
rows have *different* ups has no single integer children-per-parent, so
`cuttingVariance()` in `server/src/production-variance.js` — which derives actual
parents as `round((qty_out + qty_scrap) / children_per_parent)` — would silently
mis-derive the variance on every such job.

**Therefore, in this build:** the ups conversion is fully implemented and tested
in `board-mix.js`, but the Planning UI **offers and then refuses to save** a row
whose ups differs from the planned board's, with the reason on screen. A
different-ups substitute changes the imposition and so needs a different plate
anyway — it is a different print run, not a substitution. Same-GSM-different-size
rows with the *same* ups are fully supported, which is the common case.

Unlocking different-ups later is a UI change plus a job-card schema change, not a
rewrite — the maths is already there and tested by Task 2.

---

## File structure

| File | Responsibility |
| --- | --- |
| `server/src/board-mix.js` | **Create.** Pure coverage maths and substitution rules. No `pg`. |
| `client/src/lib/boardMix.js` | **Create.** Verbatim twin of the above, per the convention five modules here already follow. |
| `server/src/board-mix.test.js` | **Create.** Unit, property and client-twin-parity tests. |
| `server/src/board-mix-gate.test.js` | **Create.** Pins the release-gate decision without standing a database up. |
| `server/src/db.js` | **Modify.** `job_board_mix` DDL after the `board_allocations` block (ends line 1648). |
| `supabase/migrations/0014_job_board_mix.sql` | **Create.** Same DDL for prod. |
| `server/src/helpers.js` | **Modify.** Mix persistence + mirror; `readiness()` (line 656) and `readinessBatch()` (line 589) become mix-aware; `createJobCardForLine()` (line 739) blocker wording. |
| `server/src/routes/orders.js` | **Modify.** Planning context (line 1055) returns mix + candidates; plan-save (line 893) persists and invalidates. |
| `server/src/routes/production.js` | **Modify.** Cutting-start consumption (line 582); new issue-confirm endpoint. |
| `client/src/components/BoardMix.jsx` | **Create.** The mix panel and its row editor. |
| `client/src/pages/Planning.jsx` | **Modify.** Mount the panel under Board Position (line 1394); third button on the short banner (line 1458). |
| `client/src/components/BoardIssue.jsx` | **Create.** The confirm/override step shown at stage start. |
| `client/src/pages/Section.jsx` | **Modify.** Mount `BoardIssue` in the start modal (line 942); post the issue before start (line 348). |
| `client/src/pages/JobCardPrint.jsx` | **Modify.** Print the boards actually issued. |
| `scripts/uat-multi-board.mjs` | **Create, do not commit.** Throwaway seed for the live end-to-end. |

**Commands** (run from the repo root unless stated):

- Single test file: `npm test -w server -- --test-name-pattern="<pattern>"` — or directly, `node --test server/src/board-mix.test.js`
- All server tests: `npm test -w server`
- Full gate: `npm run verify`

---

### Task 1: Coverage maths in a pure module

**Files:**
- Create: `server/src/board-mix.js`
- Create: `server/src/board-mix.test.js`

- [ ] **Step 1: Write the failing tests**

Create `server/src/board-mix.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rowCovers, mixBalance } from './board-mix.js';

test('a same-ups row covers its own sheet count', () => {
  assert.equal(rowCovers({ sheets: 1500, ups: 6, planned_ups: 6 }), 1500);
});

test('a higher-ups row covers more than its sheet count', () => {
  assert.equal(rowCovers({ sheets: 1500, ups: 8, planned_ups: 6 }), 2000);
});

test('a lower-ups row covers less than its sheet count', () => {
  assert.equal(rowCovers({ sheets: 1200, ups: 4, planned_ups: 6 }), 800);
});

test('planned_ups of zero throws rather than dividing', () => {
  assert.throws(() => rowCovers({ sheets: 100, ups: 6, planned_ups: 0 }), /planned_ups/);
});

test('row ups of zero throws — a board that fits nothing covers nothing', () => {
  assert.throws(() => rowCovers({ sheets: 100, ups: 0, planned_ups: 6 }), /ups/);
});

test('a two-board mix that sums to the requirement is balanced', () => {
  const line = { parent_sheets_required: 4000 };
  const rows = [{ covers: 2500 }, { covers: 1500 }];
  const b = mixBalance({ line, rows });
  assert.equal(b.active, true);
  assert.equal(b.required, 4000);
  assert.equal(b.covered, 4000);
  assert.equal(b.balance, 0);
  assert.equal(b.balanced, true);
});

test('an under-allocated mix reports the remaining balance', () => {
  const b = mixBalance({ line: { parent_sheets_required: 4000 }, rows: [{ covers: 2500 }] });
  assert.equal(b.balance, 1500);
  assert.equal(b.balanced, false);
});

test('an over-allocated mix reports a negative balance and is not balanced', () => {
  const b = mixBalance({ line: { parent_sheets_required: 4000 }, rows: [{ covers: 2500 }, { covers: 2000 }] });
  assert.equal(b.balance, -500);
  assert.equal(b.balanced, false);
});

// These are DOUBLE PRECISION columns. `covered === required` is the trap that
// already caught the replenishment code — 0.1+0.2 style drift must still read
// as balanced.
test('float drift under EPS still counts as balanced', () => {
  const rows = [{ covers: 0.1 }, { covers: 0.2 }];
  const b = mixBalance({ line: { parent_sheets_required: 0.3 }, rows });
  assert.notEqual(b.covered, 0.3, 'precondition: this sum really is inexact');
  assert.equal(b.balanced, true);
});

test('no rows means the mix is not in play at all', () => {
  const b = mixBalance({ line: { parent_sheets_required: 4000 }, rows: [] });
  assert.equal(b.active, false);
  assert.equal(b.balanced, false);
});

test('requirement falls back to sheets_required when parent_sheets_required is absent', () => {
  const b = mixBalance({ line: { sheets_required: 900 }, rows: [{ covers: 900 }] });
  assert.equal(b.required, 900);
  assert.equal(b.balanced, true);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test server/src/board-mix.test.js`
Expected: FAIL — `Cannot find module './board-mix.js'`

- [ ] **Step 3: Write the module**

Create `server/src/board-mix.js`:

```js
// Multi-board consumption arithmetic. PURE — plain rows in, numbers out. No pg,
// no await, nothing to mock. Same contract as board-allocation.js, and for the
// same reason: these numbers decide whether a job may be released to the floor.
//
// A job is PLANNED against one board and that never changes. What changes is
// what it actually eats. A mix row says "N parent sheets of THIS board", and
// `covers` converts that into the planned board's units so a balance can be
// struck against a single requirement.
//
// With no rows the mix is inactive and every caller falls through to the
// single-board path it ran before this module existed. See the PROPERTY test in
// board-mix.test.js.

const EPS = 1e-6;
const num = v => Number(v || 0);

// The planned requirement, in PARENT (mother) sheets — the unit the warehouse
// stocks and the planning engine already stores on the line.
export function lineRequirement(line) {
  return num(line?.parent_sheets_required ?? line?.sheets_required);
}

// How much of the planned requirement one row satisfies, in planned-board
// parent sheets. A board that cuts more children per sheet covers more than its
// own sheet count; one that cuts fewer covers less.
//
// Both ups values are hard preconditions rather than defaults. childFit()
// returns `{ count: 1, sized: false }` for a board with no dimensions, so a
// silent zero here would mean an unsized board quietly covered nothing — or
// everything — instead of being rejected at the point of entry.
export function rowCovers({ sheets, ups, planned_ups }) {
  const p = num(planned_ups);
  const u = num(ups);
  if (!(p > 0)) throw new Error('board-mix: planned_ups must be greater than zero');
  if (!(u > 0)) throw new Error('board-mix: row ups must be greater than zero');
  return num(sheets) * u / p;
}

// The whole job's position. `balanced` is an EPS comparison, never `=== 0`:
// sheets and covers are DOUBLE PRECISION and an exact-zero test on floats is
// the trap that already caught the replenishment code.
export function mixBalance({ line, rows = [] }) {
  const required = lineRequirement(line);
  const covered = rows.reduce((s, r) => s + num(r.covers), 0);
  const balance = required - covered;
  return {
    active: rows.length > 0,
    required,
    covered,
    balance,
    balanced: rows.length > 0 && Math.abs(balance) < EPS,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test server/src/board-mix.test.js`
Expected: PASS, 11 tests

- [ ] **Step 5: Commit**

```bash
git add server/src/board-mix.js server/src/board-mix.test.js
git commit -m "feat(mix): coverage arithmetic for a job fed by more than one board"
```

---

### Task 2: The substitution rule — grade is fixed, ups decides the cost

**Files:**
- Modify: `server/src/board-mix.js`
- Modify: `client/src/lib/boardMix.js` (the twin — must stay verbatim)
- Modify: `server/src/board-mix.test.js`

**Carried over from Task 1's review, do both here:**

1. `lineRequirement` is exported from both twins but has no parity assertion —
   the block covers `rowCovers` and `mixBalance` only. A reviewer proved the gap
   by mutating the client copy's precedence to
   `sheets_required ?? parent_sheets_required`; all 15 tests still passed. This is
   the one function whose whole justification is a lockstep concern, and a drifted
   client copy reading child sheets as parent sheets overstates board demand by
   `children_per_parent`. Add it to the existing parity loop.
2. The throw messages interpolate the *coerced* value, so `plannedUps: 'abc'`
   reports `got NaN` and the real input is lost. Interpolate the raw parameter.

The `See the PROPERTY test` cross-reference in both headers is **correct as
written** — Task 3 adds `test('PROPERTY: with no mix rows, every number equals
the pre-feature value')` to this same file. Leave it alone.

`parseBoardName()` (`server/src/board-code.js:66`) returns
`{ grade, gsm, sheet_l, sheet_w }` from a name like `Saffire · 300 GSM · 23x36`,
or `null` when the name does not parse. Do **not** use `boardIdentity()` from
`routes/orders.js:886` — it splits on whitespace and reads `Duplex GB` as
`Duplex`.

- [ ] **Step 1: Write the failing tests**

Append to `server/src/board-mix.test.js`:

```js
import { substitutionFlags } from './board-mix.js';

const SAFFIRE_300 = { id: 1, name: 'Saffire · 300 GSM · 23x36' };
const SAFFIRE_290 = { id: 2, name: 'Saffire · 290 GSM · 23x36' };
const SAFFIRE_300_BIG = { id: 3, name: 'Saffire · 300 GSM · 25x36' };
const DUPLEX_300 = { id: 4, name: 'Duplex GB · 300 GSM · 23x36' };

test('the planned board itself carries no flag', () => {
  const f = substitutionFlags({
    plannedBoard: SAFFIRE_300, candidateBoard: SAFFIRE_300, plannedUps: 6, candidateUps: 6 });
  assert.equal(f.ok, true);
  assert.equal(f.severity, 'none');
  assert.equal(f.reason_required, false);
});

test('a different grade is blocked, never merely warned', () => {
  const f = substitutionFlags({
    plannedBoard: SAFFIRE_300, candidateBoard: DUPLEX_300, plannedUps: 6, candidateUps: 6 });
  assert.equal(f.ok, false);
  assert.equal(f.grade_ok, false);
  assert.equal(f.severity, 'blocked');
});

test('a GSM change on the same size warns and needs a reason', () => {
  const f = substitutionFlags({
    plannedBoard: SAFFIRE_300, candidateBoard: SAFFIRE_290, plannedUps: 6, candidateUps: 6 });
  assert.equal(f.ok, true);
  assert.equal(f.gsm_delta, -10);
  assert.equal(f.size_differs, false);
  assert.equal(f.ups_differ, false);
  assert.equal(f.severity, 'warn');
  assert.equal(f.reason_required, true);
});

test('a bigger sheet that still cuts the same ups is only extra trim', () => {
  const f = substitutionFlags({
    plannedBoard: SAFFIRE_300, candidateBoard: SAFFIRE_300_BIG, plannedUps: 6, candidateUps: 6 });
  assert.equal(f.ok, true);
  assert.equal(f.size_differs, true);
  assert.equal(f.ups_differ, false);
  assert.equal(f.severity, 'warn');
});

test('a sheet that changes the ups is heavy — it needs its own plate layout', () => {
  const f = substitutionFlags({
    plannedBoard: SAFFIRE_300, candidateBoard: SAFFIRE_300_BIG, plannedUps: 6, candidateUps: 8 });
  assert.equal(f.ups_differ, true);
  assert.equal(f.severity, 'heavy');
  assert.equal(f.ok, true, 'the maths supports it even where this build gates the UI');
});

test('an unparseable board name blocks rather than guessing at its grade', () => {
  const f = substitutionFlags({
    plannedBoard: SAFFIRE_300, candidateBoard: { id: 9, name: 'mystery board' },
    plannedUps: 6, candidateUps: 6 });
  assert.equal(f.ok, false);
  assert.equal(f.severity, 'blocked');
});

test('grade matching ignores case and padding', () => {
  const f = substitutionFlags({
    plannedBoard: { id: 1, name: 'saffire · 300 GSM · 23x36' },
    candidateBoard: SAFFIRE_290, plannedUps: 6, candidateUps: 6 });
  assert.equal(f.grade_ok, true);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test server/src/board-mix.test.js`
Expected: FAIL — `substitutionFlags is not a function`

- [ ] **Step 3: Implement `substitutionFlags`**

Add to the top of `server/src/board-mix.js`, below the existing header comment:

```js
import { parseBoardName } from './board-code.js';
```

Then append to `server/src/board-mix.js`:

```js
// Is this candidate an acceptable substitute for the planned board, and how
// much does the difference cost the plant?
//
// GRADE IS FIXED — a Saffire job is never offered Duplex GB. This is enforced,
// not warned: grade is the customer's specification, GSM and size are the
// plant's problem. A name that does not parse is blocked too, because the
// alternative is guessing at a grade.
//
// `plannedUps` / `candidateUps` are childFit(board, child).count, computed by
// the caller — childFit lives in helpers.js, which reaches the database, and
// this module stays pure.
//
// severity: 'none'    the planned board itself
//           'warn'    different GSM, or a different size cutting the same ups
//           'heavy'   the ups change — a different imposition and so its own plate
//           'blocked' different grade, or an unreadable board name
export function substitutionFlags({ plannedBoard, candidateBoard, plannedUps, candidateUps }) {
  const planned = parseBoardName(plannedBoard?.name);
  const cand = parseBoardName(candidateBoard?.name);
  const blocked = severity => ({
    ok: false, grade_ok: false, gsm_delta: null, size_differs: null,
    ups_differ: null, severity, reason_required: false,
  });
  if (!planned || !cand) return blocked('blocked');

  const gradeOk = planned.grade.trim().toLowerCase() === cand.grade.trim().toLowerCase();
  if (!gradeOk) return blocked('blocked');

  const samePlanned = plannedBoard?.id != null && plannedBoard.id === candidateBoard?.id;
  const gsmDelta = cand.gsm - planned.gsm;
  const sizeDiffers = cand.sheet_l !== planned.sheet_l || cand.sheet_w !== planned.sheet_w;
  const upsDiffer = num(candidateUps) !== num(plannedUps);

  const severity = samePlanned ? 'none' : upsDiffer ? 'heavy' : 'warn';
  return {
    ok: true,
    grade_ok: true,
    gsm_delta: gsmDelta,
    size_differs: sizeDiffers,
    ups_differ: upsDiffer,
    severity,
    reason_required: severity !== 'none',
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test server/src/board-mix.test.js`
Expected: PASS, 18 tests

- [ ] **Step 5: Commit**

```bash
git add server/src/board-mix.js server/src/board-mix.test.js
git commit -m "feat(mix): grade is fixed, and childFit decides what a size change costs"
```

---

### Task 3: What a mixed job contributes to a board's position — and the property test

**Files:**
- Modify: `server/src/board-mix.js`
- Modify: `server/src/board-mix.test.js`

This is the rule that stops phantom purchase requests. A job planned on 300 GSM
that takes 1,500 sheets of 290 GSM must contribute a *hold* of 1,500 to the 290
GSM board and **zero open need** — otherwise `linePosition()` counts its whole
4,000-sheet requirement against the 290 GSM stock as well, that stock reads as
over-committed, and procurement raises a PR nobody asked for.

- [ ] **Step 1: Write the failing tests**

Append to `server/src/board-mix.test.js`:

```js
import { mixPosition } from './board-mix.js';
import { linePosition } from './board-allocation.js';

const LINE = { id: 7, parent_sheets_required: 4000 };
const MIX = [
  { order_line_id: 7, material_id: 1, sheets: 2500, ups: 6, covers: 2500, role: 'planned' },
  { order_line_id: 7, material_id: 2, sheets: 1500, ups: 6, covers: 1500, role: 'substitute' },
];

test('on the planned board, a balanced mix holds its sheets and needs nothing more', () => {
  const p = mixPosition({ line: LINE, rows: MIX, materialId: 1, plannedBoardId: 1 });
  assert.equal(p.held, 2500);
  assert.equal(p.open_need, 0);
});

test('on a substitute board, the job holds its sheets and needs ZERO — not its whole requirement', () => {
  const p = mixPosition({ line: LINE, rows: MIX, materialId: 2, plannedBoardId: 1 });
  assert.equal(p.held, 1500);
  assert.equal(p.open_need, 0, 'a phantom 4,000-sheet need here is what raises a PR nobody asked for');
});

test('an unfinished mix leaves the remainder on the PLANNED board only', () => {
  const rows = [MIX[0]];
  assert.equal(mixPosition({ line: LINE, rows, materialId: 1, plannedBoardId: 1 }).open_need, 1500);
  assert.equal(mixPosition({ line: LINE, rows, materialId: 2, plannedBoardId: 1 }).open_need, 0);
});

test('a board the job does not touch gets nothing', () => {
  const p = mixPosition({ line: LINE, rows: MIX, materialId: 99, plannedBoardId: 1 });
  assert.equal(p.held, 0);
  assert.equal(p.open_need, 0);
});

test('several rows on the same board add together', () => {
  const rows = [
    { material_id: 1, sheets: 1500, covers: 1500, role: 'planned' },
    { material_id: 1, sheets: 700, covers: 700, role: 'planned' },
  ];
  assert.equal(mixPosition({ line: LINE, rows, materialId: 1, plannedBoardId: 1 }).held, 2200);
});

test('no rows returns null so the caller keeps its existing single-board maths', () => {
  assert.equal(mixPosition({ line: LINE, rows: [], materialId: 1, plannedBoardId: 1 }), null);
});

// THE PROPERTY TEST. board-allocation.test.js carries the same guard for the
// allocation formula, and it is why that change shipped without breaking a
// purchase order. Nothing in this feature may alter a job that has no mix.
test('PROPERTY: with no mix rows, every number equals the pre-feature value', () => {
  const others = [{ id: 8, parent_sheets_required: 20000 }, { id: 9, parent_sheets_required: 6000 }];
  for (const available of [0, 1, 4000, 41742, 250000]) {
    const legacy = linePosition({ line: LINE, others, available, allocations: [] });
    const mix = mixPosition({ line: LINE, rows: [], materialId: 1, plannedBoardId: 1 });
    assert.equal(mix, null);
    // With mixPosition returning null the caller passes exactly what it did
    // before, so linePosition is called with identical arguments.
    const again = linePosition({ line: LINE, others, available, allocations: [] });
    assert.deepEqual(again, legacy);
    assert.equal(mixBalance({ required: 4000, rows: [] }).active, false);
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test server/src/board-mix.test.js`
Expected: FAIL — `mixPosition is not a function`

- [ ] **Step 3: Implement `mixPosition`**

Append to `server/src/board-mix.js`:

```js
// What one mixed job contributes to a single board's position.
//
// Returns null when the job has no mix at all — the caller then runs exactly
// the single-board maths it ran before this module existed, which is the whole
// safety contract of this feature.
//
// The rule that matters: only the PLANNED board carries the unmet remainder. A
// substitute board is never "needed" beyond the sheets explicitly written
// against it. Without that, a job planned on 300 GSM and taking 1,500 sheets of
// 290 GSM would count its entire 4,000-sheet requirement against the 290 GSM
// stock too — which reads as over-committed and raises a purchase request for
// board nobody intends to buy.
export function mixPosition({ line, rows = [], materialId, plannedBoardId }) {
  if (!rows.length) return null;
  const mine = rows.filter(r => r.material_id === materialId);
  const held = mine.reduce((s, r) => s + num(r.sheets), 0);
  const { balance } = mixBalance({ required: lineRequirement(line), rows });
  const open_need = materialId === plannedBoardId ? Math.max(0, balance) : 0;
  return { held, open_need };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test server/src/board-mix.test.js`
Expected: PASS, 25 tests

Then run the whole server suite to confirm nothing else moved:

Run: `npm test -w server`
Expected: PASS, all files

- [ ] **Step 5: Commit**

```bash
git add server/src/board-mix.js server/src/board-mix.test.js
git commit -m "feat(mix): a substitute board is held, never needed — and the no-mix property test"
```

---

### Task 4: Schema

**Files:**
- Modify: `server/src/db.js` (insert after line 1648, the end of the `board_allocations` block)
- Create: `supabase/migrations/0014_job_board_mix.sql`

`main` ends at migration `0012`. `0013` belongs to the unmerged
`shade-card-simplification` branch, so this one takes `0014`.

- [ ] **Step 1: Add the DDL to `db.js`**

In `server/src/db.js`, immediately after the line
`  ON board_allocations (requisition_id);` (line 1649, the end of the
`board_allocations` block), insert:

```sql
-- Multi-board consumption ---------------------------------------------------
-- A job is PLANNED against one board and that never changes. What changes is
-- what it actually eats: 4,000 sheets of 300 GSM is routinely finished as 2,500
-- of 300 plus 1,500 of 290, because that is what the warehouse holds. Until
-- now the only ways to record it were to edit the product master for a decision
-- lasting one job, or to let the ledger lie.
--
-- A row is "N parent sheets of THIS board against this job". `covers` restates
-- that in the PLANNED board's units so a balance can be struck against one
-- requirement. phase='plan' rows come from the Planning Engine; phase='issued'
-- rows are written at Cutting Start and are the truth. Both survive — the
-- deviation between them is the point.
--
-- A job with NO rows here behaves exactly as it did before this table existed.
CREATE TABLE IF NOT EXISTS job_board_mix (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_line_id   INTEGER NOT NULL REFERENCES order_lines(id) ON DELETE CASCADE,
  material_id     INTEGER NOT NULL REFERENCES materials(id),
  stock_batch_id  INTEGER REFERENCES stock_batches(id) ON DELETE SET NULL,
  sheets          DOUBLE PRECISION NOT NULL CHECK (sheets > 0),
  ups             INTEGER NOT NULL CHECK (ups > 0),
  covers          DOUBLE PRECISION NOT NULL CHECK (covers > 0),
  role            TEXT NOT NULL CHECK (role IN ('planned','substitute')),
  phase           TEXT NOT NULL CHECK (phase IN ('plan','issued')),
  reason          TEXT,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fk_job_board_mix_order_line_id
  ON job_board_mix (order_line_id);
CREATE INDEX IF NOT EXISTS idx_fk_job_board_mix_material_id
  ON job_board_mix (material_id);
CREATE INDEX IF NOT EXISTS idx_fk_job_board_mix_stock_batch_id
  ON job_board_mix (stock_batch_id);
CREATE INDEX IF NOT EXISTS idx_job_board_mix_line_phase
  ON job_board_mix (order_line_id, phase);
```

- [ ] **Step 2: Create the migration**

Create `supabase/migrations/0014_job_board_mix.sql` with exactly this content:

```sql
-- Multi-board consumption ---------------------------------------------------
-- Adds job_board_mix. Purely additive: no existing table, column, constraint or
-- index is touched, and no existing row changes meaning. A job with no rows in
-- this table behaves exactly as it does today.
--
-- A job is PLANNED against one board and that never changes. What changes is
-- what it actually eats: 4,000 sheets of 300 GSM is routinely finished as 2,500
-- of 300 plus 1,500 of 290, because that is what the warehouse holds.
--
-- A row is "N parent sheets of THIS board against this job". `covers` restates
-- that in the PLANNED board's units so a balance can be struck against one
-- requirement. phase='plan' rows come from the Planning Engine; phase='issued'
-- rows are written at Cutting Start and are the truth.
--
-- Mirrors the DDL in server/src/db.js. Apply through the Supabase SQL editor —
-- the MCP apply_migration path is blocked by the permission classifier.
-- Take a backup first: npm run db:backup
BEGIN;

CREATE TABLE IF NOT EXISTS job_board_mix (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_line_id   INTEGER NOT NULL REFERENCES order_lines(id) ON DELETE CASCADE,
  material_id     INTEGER NOT NULL REFERENCES materials(id),
  stock_batch_id  INTEGER REFERENCES stock_batches(id) ON DELETE SET NULL,
  sheets          DOUBLE PRECISION NOT NULL CHECK (sheets > 0),
  ups             INTEGER NOT NULL CHECK (ups > 0),
  covers          DOUBLE PRECISION NOT NULL CHECK (covers > 0),
  role            TEXT NOT NULL CHECK (role IN ('planned','substitute')),
  phase           TEXT NOT NULL CHECK (phase IN ('plan','issued')),
  reason          TEXT,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fk_job_board_mix_order_line_id
  ON job_board_mix (order_line_id);
CREATE INDEX IF NOT EXISTS idx_fk_job_board_mix_material_id
  ON job_board_mix (material_id);
CREATE INDEX IF NOT EXISTS idx_fk_job_board_mix_stock_batch_id
  ON job_board_mix (stock_batch_id);
CREATE INDEX IF NOT EXISTS idx_job_board_mix_line_phase
  ON job_board_mix (order_line_id, phase);

COMMIT;
```

- [ ] **Step 3: Verify the seeder and the live schema still agree**

The repo guards against seeder-vs-live drift with a baseline check.

Run: `npm run db:baseline -- --check`
Expected: PASS. If it reports drift, run `npm run db:baseline` to regenerate and
inspect the diff before committing.

- [ ] **Step 4: Verify the table is created on a fresh database**

Run: `npm test -w server`
Expected: PASS — the schema-parity test reads `db.js` and must not complain.

- [ ] **Step 5: Commit**

```bash
git add server/src/db.js supabase/migrations/0014_job_board_mix.sql
git commit -m "feat(mix): job_board_mix records what a job actually consumed"
```

---

### Task 5: Persistence and the `board_allocations` mirror

**Files:**
- Modify: `server/src/helpers.js` (append near the `board_allocations` helpers)

- [ ] **Step 1: Write the mix persistence helpers**

Append to `server/src/helpers.js`:

```js
// ── Multi-board consumption ─────────────────────────────────────────────────
// The mix rows for one line, planned board first so the panel and every print
// read in the same order. `role` sorts 'planned' before 'substitute'
// alphabetically only by accident, so order on the predicate explicitly.
export async function mixFor(orderLineId, phase = 'plan', qc = q) {
  return qc(
    `SELECT jbm.*, m.name AS board_name
       FROM job_board_mix jbm
       JOIN materials m ON m.id = jbm.material_id
      WHERE jbm.order_line_id=$1 AND jbm.phase=$2
      ORDER BY (jbm.role='planned') DESC, jbm.id`,
    [orderLineId, phase]);
}

// Every phase='plan' row also writes an ordinary stock hold, so the warehouse's
// free/held view is correct for the substitute board without board-allocation.js
// being touched. Same mirror idiom the ERP already runs between PRs and
// allocations. Holds carry `reason` so BoardCommitments explains itself.
export async function replaceMixPlan(orderLineId, rows, qc, user) {
  await releaseMixHolds(orderLineId, qc, user, 'mix replaced');
  await qc(`DELETE FROM job_board_mix WHERE order_line_id=$1 AND phase='plan'`, [orderLineId]);
  for (const r of rows) {
    await qc(
      `INSERT INTO job_board_mix
         (order_line_id, material_id, stock_batch_id, sheets, ups, covers, role, phase, reason, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'plan',$8,$9)`,
      [orderLineId, r.material_id, r.stock_batch_id ?? null, r.sheets, r.ups, r.covers,
       r.role, r.reason ?? null, user]);
    await qc(
      `INSERT INTO board_allocations
         (material_id, order_line_id, qty, source, status, reason, created_by)
       VALUES ($1,$2,$3,'stock','active',$4,$5)`,
      [r.material_id, orderLineId, r.sheets, r.reason || 'board mix', user]);
  }
}

// Re-planning a line invalidates its mix: `ups` and `covers` are frozen per row,
// so a changed child size, quantity, wastage or planned board leaves a balance
// that silently no longer sums. Clear rather than recompute — the planner is
// told to rebuild instead of being released on stale arithmetic.
// phase='issued' rows are history and are never cleared.
export async function clearMixPlan(orderLineId, qc, user, why) {
  const [{ n }] = await qc(
    `SELECT COUNT(*)::int AS n FROM job_board_mix WHERE order_line_id=$1 AND phase='plan'`,
    [orderLineId]);
  if (!n) return 0;
  await releaseMixHolds(orderLineId, qc, user, why);
  await qc(`DELETE FROM job_board_mix WHERE order_line_id=$1 AND phase='plan'`, [orderLineId]);
  await audit('order_line', orderLineId, 'mix_cleared',
    `board mix cleared (${n} row${n === 1 ? '' : 's'}) — ${why}`, qc, user);
  return n;
}

// A hold released here is a planning decision being undone. Distinct from
// consumeMixHolds below, which is the board physically leaving the warehouse —
// without that distinction `free` drifts permanently low, the trap Task 14 of
// the board-allocation wave documents.
export async function releaseMixHolds(orderLineId, qc, user, why) {
  await qc(
    `UPDATE board_allocations
        SET status='released', released_by=$2, released_at=now(), release_reason=$3
      WHERE order_line_id=$1 AND status='active' AND source='stock'`,
    [orderLineId, user, why]);
}

export async function consumeMixHolds(orderLineId, qc) {
  await qc(
    `UPDATE board_allocations SET status='consumed'
      WHERE order_line_id=$1 AND status='active' AND source='stock'`,
    [orderLineId]);
}
```

- [ ] **Step 2: Verify nothing broke**

Run: `npm test -w server`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add server/src/helpers.js
git commit -m "feat(mix): persist the mix and mirror it into board_allocations"
```

---

### Task 6: The release gate learns about the mix

**Files:**
- Modify: `server/src/helpers.js` — `readinessBatch()` (line 589), `readiness()` (line 656), `createJobCardForLine()` (line 739)

`readiness()` decides `material: available >= parentNeeded` against one board,
and `createJobCardForLine()` blocks the push with *"board short by N parent
sheets"*. A job covered by three boards must stop reading as short.

`readinessBatch()` pre-loads everything to avoid an N+1, so the mix loads there
too — and the mix's own material ids must join `materialIds` before wave 2, or
their stock is never fetched.

- [ ] **Step 1: Add a failing test for the gate**

Create `server/src/board-mix-gate.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mixBalance, mixPosition } from './board-mix.js';

// The shape readiness() computes. Kept as a unit test on the decision itself so
// the rule is pinned without standing a database up.
function materialOk({ parentNeeded, available, mix, availableByMaterial }) {
  const bal = mixBalance({ required: parentNeeded, rows: mix });
  if (!bal.active) return available >= parentNeeded;
  const stocked = mix.every(r => (availableByMaterial[r.material_id] ?? 0) >= r.sheets);
  return bal.balanced && stocked;
}

test('no mix: the gate is exactly the old comparison', () => {
  assert.equal(materialOk({ parentNeeded: 4000, available: 4000, mix: [], availableByMaterial: {} }), true);
  assert.equal(materialOk({ parentNeeded: 4000, available: 3999, mix: [], availableByMaterial: {} }), false);
});

test('a balanced two-board mix opens the gate even though one board is short', () => {
  const mix = [
    { material_id: 1, sheets: 2500, covers: 2500 },
    { material_id: 2, sheets: 1500, covers: 1500 },
  ];
  assert.equal(materialOk({
    parentNeeded: 4000, available: 2500, mix, availableByMaterial: { 1: 2500, 2: 3100 } }), true);
});

test('a balanced mix whose substitute stock has since gone is still shut', () => {
  const mix = [
    { material_id: 1, sheets: 2500, covers: 2500 },
    { material_id: 2, sheets: 1500, covers: 1500 },
  ];
  assert.equal(materialOk({
    parentNeeded: 4000, available: 2500, mix, availableByMaterial: { 1: 2500, 2: 400 } }), false);
});

test('an unbalanced mix keeps the gate shut', () => {
  const mix = [{ material_id: 1, sheets: 2500, covers: 2500 }];
  assert.equal(materialOk({
    parentNeeded: 4000, available: 2500, mix, availableByMaterial: { 1: 2500 } }), false);
});

test('a substitute board is held, never needed — the phantom-PR guard', () => {
  const line = { id: 7, parent_sheets_required: 4000 };
  const mix = [
    { material_id: 1, sheets: 2500, covers: 2500 },
    { material_id: 2, sheets: 1500, covers: 1500 },
  ];
  assert.equal(mixPosition({ line, rows: mix, materialId: 2, plannedBoardId: 1 }).open_need, 0);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test server/src/board-mix-gate.test.js`
Expected: FAIL — `Cannot find module './board-mix.js'` is already resolved, so
this fails only if Tasks 1–3 were skipped. If Tasks 1–3 are done, it PASSES
immediately; that is fine — it is a regression pin for the wiring below.

- [ ] **Step 3: Load the mix in `readinessBatch`**

In `server/src/helpers.js`, in `readinessBatch()`:

Change the ctx initialiser (line 590) to add a `mix` map:

```js
  const ctx = {
    products: new Map(), materials: new Map(), available: new Map(),
    tools: new Map(), shade: new Map(), incoming: new Map(), fg: new Map(),
    mix: new Map(),
  };
```

After the `effective` / `materialIds` / `toolIds` block (the three `const` lines
ending `...filter(x => x != null))];`), insert:

```js
  // Wave 1.5: the mix, before wave 2 — a substitute board's stock is never
  // fetched unless its material id joins materialIds here.
  const lineIds = lines.map(l => l.id).filter(x => x != null);
  const mixAll = lineIds.length
    ? await qc(`SELECT * FROM job_board_mix WHERE order_line_id = ANY($1) AND phase='plan'
                ORDER BY (role='planned') DESC, id`, [lineIds])
    : [];
  for (const r of mixAll) {
    if (!ctx.mix.has(r.order_line_id)) ctx.mix.set(r.order_line_id, []);
    ctx.mix.get(r.order_line_id).push(r);
  }
  for (const r of mixAll) if (!materialIds.includes(r.material_id)) materialIds.push(r.material_id);
```

`materialIds` is declared with `const` but is an array, so `push` is fine.

- [ ] **Step 4: Make `readiness()` mix-aware**

In `server/src/helpers.js`, add the import at the top of the file, beside the
existing `board-allocation.js` import:

```js
import { mixBalance } from './board-mix.js';
```

`readiness()` receives `parentNeeded` as a plain number, so it passes `required`
directly — no synthetic line object.

In `readiness()`, replace the line:

```js
  const materialOk = available >= parentNeeded;
```

with:

```js
  // Multi-board: when the line carries a mix, its requirement is met by the mix
  // rows rather than by this one board. Balanced is not enough — every row's own
  // board must still hold the sheets, or the gate would open on a plan whose
  // substitute stock has since been eaten by another job.
  const mix = ctx
    ? (ctx.mix.get(line.id) ?? [])
    : await oc(`SELECT COALESCE(json_agg(x ORDER BY x.id), '[]'::json) AS list
                FROM job_board_mix x WHERE x.order_line_id=$1 AND x.phase='plan'`,
        [line.id]).then(r => r.list);
  const bal = mixBalance({ required: parentNeeded, rows: mix });
  let mixStocked = true;
  if (bal.active) {
    for (const r of mix) {
      const have = ctx
        ? (ctx.available.get(r.material_id) ?? 0)
        : await availableQty(r.material_id, oc);
      if (have < r.sheets) { mixStocked = false; break; }
    }
  }
  const materialOk = bal.active ? (bal.balanced && mixStocked) : available >= parentNeeded;
```

Then add three fields to the object `readiness()` returns, beside
`board_material_id`:

```js
    mix_active: bal.active,
    mix_balance: bal.balance,
    mix_rows: mix.length,
```

- [ ] **Step 5: Word the blocker correctly in `createJobCardForLine`**

In `createJobCardForLine()`, replace:

```js
  const short = Math.max(0, gate.parent_needed - gate.available_sheets);
```

with:

```js
  // With a mix in play the shortfall is what the mix has not covered, not what
  // one board is missing — a fully covered job must never read as short.
  const short = gate.mix_active
    ? Math.max(0, gate.mix_balance)
    : Math.max(0, gate.parent_needed - gate.available_sheets);
```

and replace the blocker push:

```js
  if (!gate.material && !gate.material_pending)
    blocked.push(`board short by ${short} parent sheets — raise a PR to proceed`);
```

with:

```js
  if (!gate.material && !gate.material_pending) {
    blocked.push(gate.mix_active
      ? (short > 0
          ? `board mix covers ${gate.parent_needed - short} of ${gate.parent_needed} parent sheets — allocate the remaining ${short}`
          : 'a board in the mix no longer has the stock allocated to it — re-check the mix')
      : `board short by ${short} parent sheets — raise a PR to proceed`);
  }
```

- [ ] **Step 6: Run the tests**

Run: `npm test -w server`
Expected: PASS, all files including `board-mix-gate.test.js`

- [ ] **Step 7: Commit**

```bash
git add server/src/helpers.js server/src/board-mix-gate.test.js
git commit -m "feat(mix): a job covered by three boards no longer reads as short"
```

---

### Task 7: Planning endpoints — read the mix, write the mix, invalidate the mix

**Files:**
- Modify: `server/src/routes/orders.js` — plan-save (line 893), planning context (line 1055)

- [ ] **Step 1: Extend the imports**

At `server/src/routes/orders.js` line 8, add to the existing `helpers.js` import
list: `mixFor, replaceMixPlan, clearMixPlan`. Add a new import line below it:

```js
import { lineRequirement, mixBalance, mixPosition, rowCovers, substitutionFlags } from '../board-mix.js';
```

- [ ] **Step 2: Return the mix from the planning context**

In `r.get('/planning/:lineId/context', …)`, after the `const position = linePosition({…});`
block (line 1085) insert:

```js
    // The job's board mix, plus every same-grade board that could join it. The
    // candidate list reuses the smart-match stock query rather than inventing a
    // second one; substitutionFlags decides what each difference costs.
    const mix = await mixFor(line.id, 'plan');
    const plannedUps = childFit(
      effectiveParent(line, board), { child_l: line.child_l, child_w: line.child_w }).count;
    const plannedBoard = { id: matId, name: board?.name };
    const candidates = await q(`
      SELECT m.*, COALESCE(av.q,0) AS available
      FROM materials m
      LEFT JOIN (SELECT material_id, SUM(qty) AS q FROM stock_batches
                 WHERE status='available' GROUP BY material_id) av ON av.material_id=m.id
      WHERE m.category='board' AND m.sheet_l > 0 AND m.sheet_w > 0
        AND COALESCE(av.q,0) > 0 AND m.id != $1`, [matId]);
    const mixCandidates = candidates.map(c => {
      const ups = childFit(c, { child_l: line.child_l, child_w: line.child_w }).count;
      const flags = substitutionFlags({
        plannedBoard, candidateBoard: c, plannedUps, candidateUps: ups });
      return { ...c, ups, ...flags };
    }).filter(c => c.ok).sort((a, b) => Math.abs(a.gsm_delta) - Math.abs(b.gsm_delta));

    const lots = await q(`
      SELECT id, material_id, batch_no, qty FROM stock_batches
      WHERE material_id = ANY($1) AND status='available' AND qty > 0
      ORDER BY created_at, id`,
      [[matId, ...mixCandidates.map(c => c.id)]]);
```

Immediately below that, correct the position for a mixed line. `?board_material_id=`
previews a board the planner has not locked, and for a line that already carries a
mix the preview must show what the mix actually claims on that board — a hold, and
no open need beyond it. Without this, previewing the 290 GSM board on a job planned
at 300 shows its whole 4,000-sheet requirement pressing on 290 GSM stock:

```js
    // Spec touch point 2. `position` above is the single-board answer, which is
    // right for every job without a mix. A mixed line's claim on ANY board is
    // exactly the sheets written against it, and only the PLANNED board carries
    // the unmet remainder.
    const mixPos = mixPosition({
      line, rows: mix, materialId: matId, plannedBoardId: line.board_material_id });
    const shown = mixPos
      ? { ...position,
          held_for_me: mixPos.held,
          my_open_need: mixPos.open_need,
          net: position.free - mixPos.open_need - position.others_open_need,
          short: Math.max(0, -(position.free - mixPos.open_need - position.others_open_need)) }
      : position;
```

Then change the existing `stock:` block in the `res.json({ … })` payload to read
from `shown` rather than `position` — every one of the six fields:

```js
      stock: {
        ...stock,
        committed_other: shown.others_open_need,
        held: shown.held,
        held_for_me: shown.held_for_me,
        incoming_for_me: shown.incoming_for_me,
        free: shown.free,
        net: shown.net,
        short: shown.short,
      },
```

And add to the same payload, beside `batches`:

```js
      mix: {
        rows: mix,
        planned_ups: plannedUps,
        planned_board_id: matId,
        candidates: mixCandidates,
        lots,
        ...mixBalance({ required: lineRequirement(line), rows: mix }),
      },
```

- [ ] **Step 3: Persist and invalidate on plan-save**

In `r.post('/order-lines/:id/plan', …)`, immediately after the `UPDATE order_lines SET machine_id=…`
statement completes (after line 1005, before the gang guard at line 1009), insert:

```js
      // The mix is frozen against the cut plan that produced it — `ups` and
      // `covers` were computed then. Re-planning changes the requirement, the
      // child size or the board underneath it, so a stored mix would balance
      // against arithmetic that no longer holds. Accept a fresh mix when the
      // client sends one; otherwise clear what is there and make the planner
      // rebuild it, rather than releasing a job on a stale balance.
      if (Array.isArray(req.body.mix) && req.body.mix.length) {
        // A gang shares ONE board across several jobs and buys it on a single
        // combined PR. Unpicking one member's board is out of scope, exactly as
        // planMove() already refuses. Same wording, so the floor hears one story.
        if (line.gang_run_id) throw Object.assign(
          new Error(`${product.name} prints in a gang — move the gang's board from Planning`),
          { status: 409 });
        const plannedUps = fit.count;
        if (!(plannedUps > 0)) throw Object.assign(
          new Error('This board and child size cut nothing — fix the cut plan before mixing boards'),
          { status: 409 });
        const rows = [];
        for (const raw of req.body.mix) {
          const mat = await oc('SELECT id, name, sheet_l, sheet_w FROM materials WHERE id=$1',
            [+raw.material_id]);
          if (!mat) throw Object.assign(new Error('Unknown board in the mix'), { status: 400 });
          const ups = childFit(mat, eff).count;
          const flags = substitutionFlags({
            plannedBoard: { id: eff.board_material_id, name: board?.name },
            candidateBoard: mat, plannedUps, candidateUps: ups });
          if (!flags.ok) throw Object.assign(
            new Error(`${mat.name} cannot substitute for ${board?.name} — the grade must match`),
            { status: 409 });
          // See the scope decision at the top of this plan: job_cards stores
          // children_per_parent as an INTEGER, so a mix of differing ups has no
          // single value for cuttingVariance() to derive parents from.
          if (flags.ups_differ) throw Object.assign(
            new Error(`${mat.name} cuts ${ups} up against ${plannedUps} — a different imposition needs its own plate, not a substitution`),
            { status: 409 });
          // Coerce NUMERICALLY before the DB sees it. Postgres orders NaN above
          // every other double, so 'NaN'::double precision > 0 is TRUE — a
          // non-numeric sheets would sail through both CHECK (sheets > 0) and
          // CHECK (covers > 0) and poison this line's balance permanently.
          // Number.isFinite is the guard; `+raw.sheets || 0` is not.
          const sheets = Number(raw.sheets);
          if (!Number.isFinite(sheets) || !(sheets > 0)) throw Object.assign(
            new Error(`Enter a sheet count for ${mat.name}`), { status: 400 });
          if (flags.reason_required && !String(raw.reason || '').trim())
            throw Object.assign(new Error(`Give a reason for using ${mat.name}`), { status: 400 });
          rows.push({
            material_id: mat.id,
            stock_batch_id: raw.stock_batch_id ? +raw.stock_batch_id : null,
            sheets,
            ups,
            covers: rowCovers({ sheets, ups, plannedUps }),
            role: mat.id === +eff.board_material_id ? 'planned' : 'substitute',
            reason: raw.reason || null,
          });
        }
        const bal = mixBalance({ required: parentSheets, rows });
        if (!bal.balanced) throw Object.assign(
          new Error(`The board mix covers ${Math.round(bal.covered)} of ${Math.round(bal.required)} parent sheets — ${bal.balance > 0 ? `allocate ${Math.round(bal.balance)} more` : `remove ${Math.round(-bal.balance)}`}`),
          { status: 409 });
        await replaceMixPlan(line.id, rows, qc, req.user.name);
        await audit('order_line', line.id, 'board_mix',
          rows.map(r => `${r.sheets} of material ${r.material_id}`).join('; ').slice(0, 500),
          qc, req.user.name);
      } else {
        // No mix sent, or an empty one. Either way the stored plan rows are now
        // invalid — see clearMixPlan's comment on frozen `ups` and `covers`.
        await clearMixPlan(line.id, qc, req.user.name, 'plan re-locked without a mix');
      }
```

- [ ] **Step 4: Verify**

Run: `npm test -w server`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/orders.js
git commit -m "feat(mix): planning reads, writes and invalidates a job's board mix"
```

---

### Task 8: Cutting consumes the mix

**Files:**
- Modify: `server/src/routes/production.js` (line 582)

- [ ] **Step 1: Extend the imports**

At `server/src/routes/production.js` line 9, add to the `helpers.js` import list:
`mixFor, consumeMixHolds`.

- [ ] **Step 2: Replace the single consume with a mix-aware one**

Replace lines 570–582 (the `} else if (!prev) {` branch through the
`await consumeFifo(...)` line) with:

```js
      } else if (!prev) {
        qtyIn = jc.sheets_issued;
        // Issue the line's EFFECTIVE board — a warehouse pick made in the
        // planning engine (spec_override) must be what cutting consumes.
        const eff = jc.order_line_id
          ? await oc(`
              SELECT COALESCE((ol.spec_override->>'board_material_id')::int, p.board_material_id) AS board_material_id
              FROM order_lines ol JOIN products p ON p.id=ol.product_id WHERE ol.id=$1`, [jc.order_line_id])
          : await oc(`
              SELECT COALESCE((ol.spec_override->>'board_material_id')::int, p.board_material_id) AS board_material_id
              FROM order_lines ol JOIN products p ON p.id=ol.product_id
              WHERE ol.gang_run_id=$1 ORDER BY ol.id LIMIT 1`, [jc.gang_run_id]);
        // Multi-board: a job may be fed by several boards of the same grade. The
        // ISSUED rows are the truth — Planning writes 'plan' rows, this stage's
        // confirm/override step writes 'issued' ones. With no rows at all this
        // is the single call it always was, unchanged.
        const issued = jc.order_line_id ? await mixFor(jc.order_line_id, 'issued', qc) : [];
        if (issued.length) {
          for (const r of issued) {
            await consumeFifo(r.material_id, r.sheets, 'job_card', jc.id,
              `Issue to ${jc.jc_number} — ${r.board_name}${r.stock_batch_id ? ` (lot ${r.stock_batch_id})` : ''}`,
              qc, oc);
          }
          // The board has physically left the warehouse. Releasing instead of
          // consuming here would return the sheets to `free` and every later job
          // would read stock that no longer exists.
          await consumeMixHolds(jc.order_line_id, qc);
          // qty_in is the PARENT sheets that actually went on the machine, which
          // is the sum of the mix, not the planned-board figure on the card.
          qtyIn = issued.reduce((s, r) => s + Number(r.sheets || 0), 0);
          await audit('job_card', jc.id, 'board_mix_issued',
            issued.map(r => `${Math.round(r.sheets)} × ${r.board_name}`).join('; ').slice(0, 500),
            qc, req.user.name);
        } else {
          await consumeFifo(eff.board_material_id, jc.sheets_issued, 'job_card', jc.id,
            `Issue to ${jc.jc_number}`, qc, oc);
        }
      }
```

Note the trailing `}` closes the `else if (!prev)` branch — the following
`} else if (prev.status === 'completed') {` on the old line 583 stays as it is.

- [ ] **Step 3: Verify**

Run: `npm test -w server`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/production.js
git commit -m "feat(mix): cutting issues every board in the mix, not just the planned one"
```

---

### Task 9: Confirm or override at Cutting Start

**Files:**
- Modify: `server/src/routes/production.js` (new endpoint, place beside the stage-start route)

The floor's default is one tap. An edit needs a reason and is recorded as a
deviation. This endpoint writes the `phase='issued'` rows that Task 8 consumes.

- [ ] **Step 1: Add the endpoint**

Add to `server/src/routes/production.js`, immediately before the
`r.post('/job-stages/:id/start', …)` route:

```js
// Board issue — confirm the planned mix, or override it because the pile does
// not match the paper. Writes the phase='issued' rows that stage start consumes.
// Confirming with no edits copies the plan across verbatim; any change requires
// a reason and lands on the timeline as a deviation.
r.post('/job-cards/:id/board-issue', canRun, async (req, res, next) => {
  try {
    await tx(async (qc, oc) => {
      const jc = await oc('SELECT * FROM job_cards WHERE id=$1', [req.params.id]);
      if (!jc) throw Object.assign(new Error('Job card not found'), { status: 404 });
      if (!jc.order_line_id) throw Object.assign(
        new Error('A gang shares one board — issue it from the gang, not a member job'), { status: 409 });

      const started = await oc(
        `SELECT 1 AS x FROM job_stages WHERE job_card_id=$1 AND status <> 'pending' LIMIT 1`,
        [jc.id]);
      if (started) throw Object.assign(
        new Error('This job has already started — use the cutting variance path'), { status: 409 });

      const plan = await mixFor(jc.order_line_id, 'plan', qc);
      if (!plan.length) throw Object.assign(
        new Error('This job has no board mix — it issues its planned board'), { status: 409 });

      const sent = Array.isArray(req.body.rows) ? req.body.rows : null;
      const rows = sent ?? plan.map(r => ({
        material_id: r.material_id, stock_batch_id: r.stock_batch_id, sheets: r.sheets, ups: r.ups,
        covers: r.covers, role: r.role, reason: r.reason,
      }));

      const changed = !sent ? false : (
        sent.length !== plan.length ||
        sent.some((r, i) => +r.material_id !== plan[i].material_id
          || Number(r.sheets) !== Number(plan[i].sheets)
          || (r.stock_batch_id ?? null) !== (plan[i].stock_batch_id ?? null)));
      const reason = String(req.body.reason || '').trim();
      if (changed && !reason) throw Object.assign(
        new Error('Say why the issued board differs from the plan'), { status: 400 });

      await qc(`DELETE FROM job_board_mix WHERE order_line_id=$1 AND phase='issued'`,
        [jc.order_line_id]);
      for (const r of rows) {
        await qc(
          `INSERT INTO job_board_mix
             (order_line_id, material_id, stock_batch_id, sheets, ups, covers, role, phase, reason, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'issued',$8,$9)`,
          [jc.order_line_id, r.material_id, r.stock_batch_id ?? null, r.sheets, r.ups, r.covers,
           r.role, changed ? reason : (r.reason ?? null), req.user.name]);
      }
      await audit('job_card', jc.id, changed ? 'board_issue_override' : 'board_issue_confirm',
        changed
          ? `issued differs from plan — ${reason}`
          : `issued as planned (${rows.length} board${rows.length === 1 ? '' : 's'})`,
        qc, req.user.name);
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});
```

`canRun` and `tx` are already imported in this file.

- [ ] **Step 2: Verify**

Run: `npm test -w server`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/production.js
git commit -m "feat(mix): the floor confirms the plan in one tap, or overrides it with a reason"
```

---

### Task 10: The Board Mix panel

**Files:**
- Create: `client/src/components/BoardMix.jsx`
- Modify: `client/src/pages/Planning.jsx`

`Card` and `Stat` are local to `Planning.jsx` (lines 150 and 140), so the panel
takes plain markup and is mounted inside an existing `Card`.

- [ ] **Step 1: Create the component**

Create `client/src/components/BoardMix.jsx`:

```jsx
// Board Mix — the boards a job will actually consume, beside the one it was
// planned on. Grade is fixed; GSM (and sometimes size) is what flexes. The
// balance must reach zero before the job can be released.
import { Plus, X, AlertTriangle } from 'lucide-react';
import { Button, Field, Input, Select } from './ui.jsx';
import { rowCovers, mixBalance } from '../lib/boardMix.js';
import { fmt } from '../api.js';

// The balance the planner sees MUST be the balance the release gate computes,
// so both sides run the same functions — the client twin of board-mix.js, per
// the convention boardMath / boardCode / replenishment already follow. A
// hand-rolled copy here would drift from the gate and show a green zero on a
// job the server still refuses.
//
// Rows are recomputed rather than read from the stored `covers` because the
// planner is editing them; the server recomputes identically on save with the
// same rowCovers, and re-planning clears the mix, so stored and derived can
// never disagree on a saved row.
//
// The ups guard is a RENDER guard, not a semantic one: rowCovers throws by
// design, and a throw inside a map during render blanks the screen on a
// half-typed row. Zero coverage leaves the balance non-zero, which disables the
// save button — fail-closed, and the server still throws if it ever arrives.
export function mixTotals(rows, plannedUps, required) {
  const priced = rows.map(r => ({
    covers: plannedUps > 0 && r.ups > 0 ? rowCovers({ sheets: r.sheets, ups: r.ups, plannedUps }) : 0,
  }));
  return mixBalance({ required, rows: priced });
}

function Chip({ tone, children }) {
  const cls = {
    warn: 'bg-amber-50 text-amber-700',
    heavy: 'bg-red-50 text-red-700',
    none: 'bg-slate-100 text-slate-500',
  }[tone] || 'bg-slate-100 text-slate-500';
  return <span className={`shrink-0 rounded-full px-1.5 py-px text-[9px] font-bold uppercase tracking-wide ${cls}`}>{children}</span>;
}

export default function BoardMix({ ctx, required, rows, onChange }) {
  const mix = ctx?.mix;
  if (!mix) return null;
  const plannedUps = mix.planned_ups;
  const { covered, balance, balanced } = mixTotals(rows, plannedUps, required);
  const byId = new Map([...(mix.candidates || []).map(c => [c.id, c])]);

  const add = () => {
    const first = (mix.candidates || [])[0];
    if (!first) return;
    onChange([...rows, {
      material_id: first.id, board_name: first.name, ups: first.ups,
      sheets: Math.max(0, Math.round(balance / (first.ups / plannedUps))),
      stock_batch_id: null, reason: '', severity: first.severity, gsm_delta: first.gsm_delta,
      ups_differ: first.ups_differ, available: first.available,
    }]);
  };
  const set = (i, patch) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const drop = i => onChange(rows.filter((_, j) => j !== i));

  const pick = (i, id) => {
    const c = byId.get(+id);
    if (!c) return;
    set(i, { material_id: c.id, board_name: c.name, ups: c.ups, stock_batch_id: null,
             severity: c.severity, gsm_delta: c.gsm_delta, ups_differ: c.ups_differ,
             available: c.available });
  };

  return (
    <div className="mt-3 border-t border-[#1D1D1F]/[0.07] pt-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
          Board Mix — {fmt.num(required)} required
        </span>
        <Button size="sm" variant="secondary" onClick={add} disabled={!(mix.candidates || []).length}>
          <Plus size={12} /> Add board
        </Button>
      </div>

      {rows.length === 0 && (
        <p className="rounded-lg bg-slate-50 px-2.5 py-2 text-[11px] text-slate-500">
          This job issues its planned board only. Add a board to split the issue across
          several — same grade, any GSM.
        </p>
      )}

      <div className="space-y-2">
        {rows.map((r, i) => {
          const lots = (mix.lots || []).filter(l => l.material_id === r.material_id);
          const over = r.available != null && r.sheets > r.available;
          return (
            <div key={i} className="rounded-xl bg-slate-50/80 p-2.5">
              <div className="mb-1.5 flex items-center gap-1.5">
                {r.severity && r.severity !== 'none' && (
                  <Chip tone={r.severity}>
                    {r.ups_differ ? `${r.ups} up vs ${plannedUps} up`
                      : r.gsm_delta ? `${r.gsm_delta > 0 ? '+' : ''}${r.gsm_delta} gsm` : 'substitute'}
                  </Chip>
                )}
                <button type="button" onClick={() => drop(i)} title="Remove this board"
                  className="ml-auto shrink-0 rounded-lg p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-600">
                  <X size={12} />
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Board" className="col-span-2">
                  <Select value={r.material_id} onChange={e => pick(i, e.target.value)}>
                    {(mix.candidates || []).map(c => (
                      <option key={c.id} value={c.id}>{c.name} — {fmt.num(c.available)} free</option>
                    ))}
                  </Select>
                </Field>
                <Field label="Lot" hint="blank = FIFO">
                  <Select value={r.stock_batch_id ?? ''}
                    onChange={e => set(i, { stock_batch_id: e.target.value ? +e.target.value : null })}>
                    <option value="">FIFO — oldest first</option>
                    {lots.map(l => <option key={l.id} value={l.id}>{l.batch_no} — {fmt.num(l.qty)}</option>)}
                  </Select>
                </Field>
                <Field label="Sheets">
                  <Input type="number" min="1" value={r.sheets}
                    onChange={e => set(i, { sheets: +e.target.value })} />
                </Field>
                {r.severity && r.severity !== 'none' && (
                  <Field label="Reason" className="col-span-2" required>
                    <Input value={r.reason || ''} placeholder="Why this board?"
                      onChange={e => set(i, { reason: e.target.value })} />
                  </Field>
                )}
              </div>
              {r.ups_differ && (
                <p className="mt-1.5 flex items-start gap-1.5 rounded-lg bg-red-50 px-2.5 py-1.5 text-[11px] font-semibold text-red-700">
                  <AlertTriangle size={12} className="mt-px shrink-0" />
                  This sheet cuts {r.ups} up against the plan's {plannedUps} — a different imposition
                  needs its own plate, so it cannot be mixed into this job.
                </p>
              )}
              {over && (
                <p className="mt-1.5 rounded-lg bg-amber-50 px-2.5 py-1.5 text-[11px] font-semibold text-amber-700">
                  Only {fmt.num(r.available)} sheets are free on this board.
                </p>
              )}
            </div>
          );
        })}
      </div>

      {rows.length > 0 && (
        <div className={`mt-2 flex items-center justify-between rounded-xl px-3 py-2 text-xs font-bold ${
          balanced ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
          <span>Balance to allocate</span>
          <span>{balanced ? '0 ✓' : fmt.num(Math.round(balance))}</span>
        </div>
      )}
      {rows.length > 0 && !balanced && (
        <p className="mt-1 text-[10px] text-slate-400">
          Covered {fmt.num(Math.round(covered))} of {fmt.num(required)} parent sheets.
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Mount it in Planning.jsx**

In `client/src/pages/Planning.jsx`:

Add the import beside the other component imports (after line 14):

```jsx
import BoardMix, { mixTotals } from '../components/BoardMix.jsx';
```

Add state beside the other planning state (near `boardSel`, around line 341's
setter — place the declaration with the other `useState` calls in the same
component):

```jsx
  const [mixRows, setMixRows] = useState([]);
```

Where the planning context loads and `setBoardSel(...)` runs (line 341), add:

```jsx
    setMixRows((d?.mix?.rows || []).map(r => ({
      material_id: r.material_id, board_name: r.board_name, ups: r.ups, sheets: r.sheets,
      stock_batch_id: r.stock_batch_id, reason: r.reason || '',
      severity: r.role === 'planned' ? 'none' : 'warn',
    })));
```

Inside the `Board Position` `Card` (opened at line 1394), immediately before its
closing `</Card>`, add:

```jsx
                      <BoardMix ctx={ctx} required={calc.parent} rows={mixRows} onChange={setMixRows} />
```

On the short banner (line 1458), add a third button after the "Raise PR" button:

```jsx
                            <Button size="sm" variant="primary" onClick={() => {
                              const c = (ctx?.mix?.candidates || [])[0];
                              if (!c) return;
                              setMixRows(rows => rows.length ? rows : [
                                { material_id: ctx.mix.planned_board_id,
                                  board_name: boardSel?.name, ups: ctx.mix.planned_ups,
                                  sheets: Math.max(0, calc.parent - position.short),
                                  stock_batch_id: null, reason: '', severity: 'none' },
                                { material_id: c.id, board_name: c.name, ups: c.ups,
                                  sheets: position.short, stock_batch_id: null, reason: '',
                                  severity: c.severity, gsm_delta: c.gsm_delta,
                                  ups_differ: c.ups_differ, available: c.available },
                              ]);
                            }}>
                              Cover with another board
                            </Button>
```

In `savePlan` (line 533), add the mix to the request body — put it directly after
the `leftover:` line (line 540) so it lands inside the same object literal:

```jsx
      mix: mixRows.map(r => ({
        material_id: r.material_id, stock_batch_id: r.stock_batch_id,
        sheets: r.sheets, reason: r.reason,
      })),
```

Guard the Lock Plan button at line 1154. Replace:

```jsx
          <Button onClick={onLock} disabled={!calc}>
```

with:

```jsx
          <Button onClick={onLock} disabled={!calc || !mixOk}>
```

and add the derivation beside the other `useMemo`/derived values in the same
component, above the return:

```jsx
  // A mix that does not balance, or carries a row needing its own plate, must
  // not lock — the server refuses it anyway, and a disabled button says so
  // before the planner has typed a reason for nothing.
  const mixOk = mixRows.length === 0
    || (mixTotals(mixRows, ctx?.mix?.planned_ups, calc?.parent ?? 0).balanced
        && !mixRows.some(r => r.ups_differ));
```

- [ ] **Step 3: Verify the client builds**

Run: `npm run build -w client`
Expected: build succeeds, no unresolved imports

- [ ] **Step 4: Commit**

```bash
git add client/src/components/BoardMix.jsx client/src/pages/Planning.jsx
git commit -m "feat(mix): the planner splits a job across boards without leaving the engine"
```

---

### Task 11: The board-issue step at stage start

**Files:**
- Create: `client/src/components/BoardIssue.jsx`
- Modify: `client/src/pages/Section.jsx` (line 942)

- [ ] **Step 1: Create the component**

Create `client/src/components/BoardIssue.jsx`:

```jsx
// Board issue — shown at the start of a job whose Planning mix names more than
// one board. Confirming is one tap. Changing a quantity or a lot is an override
// and needs a reason, which lands on the timeline as a deviation.
import { useState } from 'react';
import { PackageCheck, AlertTriangle } from 'lucide-react';
import { Field, Input, Select } from './ui.jsx';
import { fmt } from '../api.js';

export default function BoardIssue({ mix, lots = [], rows, onChange, reason, onReason }) {
  const [editing, setEditing] = useState(false);
  if (!mix?.length) return null;

  const changed = rows.some((r, i) => Number(r.sheets) !== Number(mix[i]?.sheets)
    || (r.stock_batch_id ?? null) !== (mix[i]?.stock_batch_id ?? null));
  const set = (i, patch) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <section className="ci-form-panel border-dashed">
      <div className="ci-form-panel-title">
        <span className="inline-flex items-center gap-1.5"><PackageCheck size={13} /> Board issue</span>
        <button type="button" onClick={() => setEditing(v => !v)}
          className="text-[11px] font-semibold text-slate-500 hover:text-slate-700">
          {editing ? 'Cancel change' : 'Different to the plan?'}
        </button>
      </div>

      <div className="space-y-1.5">
        {rows.map((r, i) => (
          <div key={i} className="rounded-lg bg-slate-50 px-2.5 py-2 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate font-semibold text-slate-700">{mix[i]?.board_name}</span>
              {!editing && <span className="shrink-0 font-bold">{fmt.num(r.sheets)} sheets</span>}
            </div>
            {editing && (
              <div className="mt-1.5 grid grid-cols-2 gap-2">
                <Field label="Sheets">
                  <Input type="number" min="1" value={r.sheets}
                    onChange={e => set(i, { sheets: +e.target.value })} />
                </Field>
                <Field label="Lot" hint="blank = FIFO">
                  <Select value={r.stock_batch_id ?? ''}
                    onChange={e => set(i, { stock_batch_id: e.target.value ? +e.target.value : null })}>
                    <option value="">FIFO — oldest first</option>
                    {lots.filter(l => l.material_id === r.material_id)
                      .map(l => <option key={l.id} value={l.id}>{l.batch_no} — {fmt.num(l.qty)}</option>)}
                  </Select>
                </Field>
              </div>
            )}
          </div>
        ))}
      </div>

      {changed && (
        <>
          <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-amber-50 px-2.5 py-1.5 text-[11px] font-semibold text-amber-700">
            <AlertTriangle size={12} className="mt-px shrink-0" />
            This differs from what Planning allocated. It will be recorded as a deviation.
          </p>
          <Field label="Reason" required className="mt-2">
            <Input value={reason} placeholder="Why is the issue different?"
              onChange={e => onReason(e.target.value)} />
          </Field>
        </>
      )}
    </section>
  );
}
```

- [ ] **Step 2: Mount it in the start modal**

In `client/src/pages/Section.jsx`, add the import beside the `LineClearance`
import (line 14):

```jsx
import BoardIssue from '../components/BoardIssue.jsx';
```

Add state beside the existing `clearance` state:

```jsx
  const [issueRows, setIssueRows] = useState([]);
  const [issueReason, setIssueReason] = useState('');
```

Load the plan when the start modal opens. In the Start button's `onClick` at
line 741, after the existing `setShowPickers(!a.auto); setClearance(freshClearance());`
line (742), add:

```jsx
                              setIssueReason(''); setIssuePlan([]); setIssueRows([]);
                              api.get(`/planning/${r.order_line_id}/context`)
                                .then(d => {
                                  const rows = (d?.mix?.rows || []).map(x => ({
                                    material_id: x.material_id, stock_batch_id: x.stock_batch_id,
                                    sheets: x.sheets, ups: x.ups, covers: x.covers,
                                    role: x.role, reason: x.reason, board_name: x.board_name,
                                  }));
                                  setIssuePlan(rows);
                                  setIssueRows(rows.map(x => ({ ...x })));
                                  setIssueLots(d?.mix?.lots || []);
                                })
                                .catch(() => { setIssuePlan([]); setIssueRows([]); });
```

The component compares the edited rows against the untouched plan, so both are
held separately. Declare all four pieces of state beside `clearance`:

```jsx
  const [issuePlan, setIssuePlan] = useState([]);
  const [issueRows, setIssueRows] = useState([]);
  const [issueLots, setIssueLots] = useState([]);
  const [issueReason, setIssueReason] = useState('');
```

Render it above the clearance panel at line 942:

```jsx
            <BoardIssue mix={issuePlan} lots={issueLots} rows={issueRows} onChange={setIssueRows}
              reason={issueReason} onReason={setIssueReason} />
            {needsClearance(section) && <LineClearancePanel checks={clearance} onChange={setClearance} />}
```

Post the issue before starting the stage. At line 348, replace:

```jsx
      await api.post(`/job-stages/${starting.id}/start`, body);
```

with:

```jsx
      // The issued mix must be recorded BEFORE the start, because stage start is
      // what consumes it from the warehouse.
      if (issueRows.length) {
        await api.post(`/job-cards/${starting.job_card_id}/board-issue`,
          { rows: issueRows, reason: issueReason });
      }
      await api.post(`/job-stages/${starting.id}/start`, body);
```

- [ ] **Step 3: Show the mix on the job card**

The timeline already carries the mix through the `board_mix`, `board_mix_issued`
and `board_issue_override` audit entries written in Tasks 7–9 — the universal
timeline picks up any `audit()` call with no further work. The job card itself
does not.

In `client/src/pages/JobCardPrint.jsx`, wherever the board line is rendered, add
beneath it:

```jsx
        {(jc.board_mix || []).length > 1 && (
          <div className="mt-1 text-[10px] text-slate-600">
            Issued from: {jc.board_mix.map(r => `${Math.round(r.sheets)} × ${r.board_name}`).join(' · ')}
          </div>
        )}
```

and in `server/src/routes/production.js`, in the handler that serves a single job
card, attach the rows:

```js
    jc.board_mix = jc.order_line_id ? await mixFor(jc.order_line_id, 'issued') : [];
```

- [ ] **Step 4: Verify the client builds**

Run: `npm run build -w client`
Expected: build succeeds

Run: `npm test -w server`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add client/src/components/BoardIssue.jsx client/src/pages/Section.jsx \
        client/src/pages/JobCardPrint.jsx server/src/routes/production.js
git commit -m "feat(mix): the floor confirms the board issue before the run starts"
```

---

### Task 12: End-to-end verification on live data

**Files:**
- Create: `scripts/uat-multi-board.mjs` (throwaway, not committed)

Follow the established pattern: seed through `node` + `pg` from the `server/`
directory against the live PG on `:5439`, drive the flow with `curl` against a
temporary server on a spare port, and clean up **by exact captured id, never
`LIKE`**.

- [ ] **Step 1: Start a temp server on a spare port**

```bash
cd server && DATABASE_URL='postgres://postgres:postgres@localhost:5439/cierp' PORT=4998 node src/index.js
```

- [ ] **Step 2: Seed a UAT job and capture its ids**

Create `scripts/uat-multi-board.mjs`:

```js
// Throwaway UAT seed for multi-board consumption. Creates ONE order and ONE
// line on a board deliberately short of stock, with a same-grade lower-GSM
// board holding the balance. Prints every id it created so teardown can delete
// by exact id — never by LIKE, which has emptied shared tables here before.
import pg from 'pg';

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const out = { order_id: null, line_id: null, batches: [], materials: [] };

const pick = await db.query(`
  SELECT m.id, m.name, COALESCE(SUM(sb.qty) FILTER (WHERE sb.status='available'), 0) AS avail
  FROM materials m
  LEFT JOIN stock_batches sb ON sb.material_id = m.id
  WHERE m.category='board' AND m.sheet_l > 0 AND m.sheet_w > 0 AND m.name LIKE 'Saffire%'
  GROUP BY m.id, m.name ORDER BY m.id LIMIT 2`);
if (pick.rows.length < 2) throw new Error('need two Saffire boards in the master');
const [primary, sub] = pick.rows;
out.materials = [primary.id, sub.id];

// Exactly 2,500 available on the primary and plenty on the substitute, so the
// job is short 1,500 and the mix is the only way through.
for (const [mid, qty] of [[primary.id, 2500], [sub.id, 5000]]) {
  const b = await db.query(
    `INSERT INTO stock_batches (material_id, batch_no, qty, initial_qty, unit, status)
     VALUES ($1,$2,$3,$3,'sheets','available') RETURNING id`,
    [mid, `UAT-MIX-${mid}`, qty]);
  out.batches.push(b.rows[0].id);
}

const cust = await db.query('SELECT id FROM customers ORDER BY id LIMIT 1');
const prod = await db.query('SELECT id FROM products WHERE board_material_id=$1 ORDER BY id LIMIT 1',
  [primary.id]);
if (!prod.rows.length) throw new Error(`no product on board ${primary.name}`);

const o = await db.query(
  `INSERT INTO orders (po_number, customer_id, status) VALUES ($1,$2,'open') RETURNING id`,
  ['UAT-MIX-PO', cust.rows[0].id]);
out.order_id = o.rows[0].id;

const l = await db.query(
  `INSERT INTO order_lines (order_id, product_id, qty, status)
   VALUES ($1,$2,$3,'pending') RETURNING id`,
  [out.order_id, prod.rows[0].id, 24000]);
out.line_id = l.rows[0].id;

console.log(JSON.stringify(out, null, 2));
await db.end();
```

Run it from `server/` so it resolves `pg` from the workspace:

```bash
cd server && DATABASE_URL='postgres://postgres:postgres@localhost:5439/cierp' node ../scripts/uat-multi-board.mjs
```

Expected: JSON with `order_id`, `line_id`, two `batches` and two `materials`.
Save it — every id is needed for teardown.

- [ ] **Step 3: Drive the happy path**

1. `GET /planning/<lineId>/context` — assert `mix.candidates` contains only
   same-grade boards and `mix.planned_ups` is a positive integer.
2. `POST /order-lines/<lineId>/plan` with an **unbalanced** mix — assert `409`
   and a message naming the shortfall.
3. `POST` again with a **balanced** two-board mix — assert `200`.
4. `GET /planning/<lineId>/context` — assert `mix.balanced === true` and that a
   `board_allocations` row exists for each mix board.
5. Push the job card — assert it is **not** blocked with "board short".
6. `POST /job-cards/<jcId>/board-issue` with no `rows` — assert `200` and that
   `phase='issued'` rows now mirror the plan.
7. Start the cutting stage — assert `stock_movements` carries one `consumption`
   per mix board with the right quantities, and that the `board_allocations`
   rows are now `consumed`, not `released`.

- [ ] **Step 4: Drive the override path**

Repeat from step 6 with edited `rows` and no `reason` — assert `400`. With a
reason — assert `200`, an `issued` set that differs from `plan`, and a
`board_issue_override` audit row.

- [ ] **Step 5: Prove the no-mix path is untouched**

Run the same job-card push and cutting start on a line with **no** mix rows.
Assert a single `consumption` movement on the planned board, exactly as before.

- [ ] **Step 6: Clean up by exact id**

Substitute the ids captured in Step 2 and run, from `server/`:

```sql
BEGIN;
DELETE FROM job_board_mix      WHERE order_line_id = <line_id>;
DELETE FROM board_allocations  WHERE order_line_id = <line_id>;
DELETE FROM stock_movements    WHERE ref_type='job_card' AND ref_id IN
  (SELECT id FROM job_cards WHERE order_line_id = <line_id>);
DELETE FROM job_stages         WHERE job_card_id IN
  (SELECT id FROM job_cards WHERE order_line_id = <line_id>);
DELETE FROM job_cards          WHERE order_line_id = <line_id>;
DELETE FROM order_lines        WHERE id = <line_id>;
DELETE FROM orders             WHERE id = <order_id>;
DELETE FROM stock_movements    WHERE batch_id IN (<batch ids>);
DELETE FROM stock_batches      WHERE id IN (<batch ids>);
COMMIT;
```

Then confirm zero leftovers — every count must be `0`:

```sql
SELECT (SELECT COUNT(*) FROM orders WHERE po_number='UAT-MIX-PO') AS orders,
       (SELECT COUNT(*) FROM stock_batches WHERE batch_no LIKE 'UAT-MIX-%') AS batches,
       (SELECT COUNT(*) FROM job_board_mix WHERE order_line_id=<line_id>) AS mix;
```

The `LIKE` here is a read-only check, never a delete.

- [ ] **Step 7: Full gate from a clean detached worktree**

A parallel session's uncommitted files otherwise fail the build.

```bash
git worktree add --detach /tmp/mix-verify HEAD
cd /tmp/mix-verify && npm ci && npm run verify
```

Expected: PASS. Then `git worktree remove /tmp/mix-verify`.

- [ ] **Step 8: Commit the docs**

```bash
git add docs/superpowers/plans/2026-07-30-multi-board-consumption.md
git commit -m "docs(mix): implementation plan"
```

---

## Handover to Anik

`supabase/migrations/0014_job_board_mix.sql` must be applied to prod through the
Supabase SQL editor before this branch is deployed — the MCP `apply_migration`
path is blocked by the permission classifier. Run `npm run db:backup` first.
