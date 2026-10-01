# Carton Made in Parts: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A saleable carton that is printed as separate pieces is handled end to end with no manual judgement. Each piece is printed on its own sheet and board size, die-cut apart, and pasted together at Sort & Paste. Example: VOGEAB GM1 / GM2 outer carton, SW-712 / SW-715 / SW-716. The PO person orders only the carton. Each part's board is covered, raised and issued on its own board, with no maths by hand. Finished goods only ever sees the whole carton.

**Architecture:**
- The **outer carton** keeps its one Product Master row. A new **`product_parts`** table lists its parts. Each part is an ordinary Product Master row with its own board, sheet size, ups, die and plate.
- When an order line for an outer carton is saved, the server keeps one hidden **part line** per part (`order_lines.part_of_line_id` → the carton line). Because a part line is an ordinary line, **every existing per-line board mechanism works for it unchanged**: Planning Engine, Covered / Short / PR Raised, plan-lock holds, PR, readiness and job card.
- The carton line itself carries **zero** board and is hidden from Planning.
- A part's job card runs **cutting → die cutting only**. When it completes die cutting it becomes `split`, a state that already means "done, not finished goods".
- When the **last** part is die-cut, the server creates the **pasting card** (`job_cards.is_assembly = true`) for the carton line. It has the same two stages a split gang child runs, sorting → pasting, and is sized to the scarcer part.
- Closing the pasting card at Sort & Paste credits FG with the outer carton through the existing closer. Nothing else ever credits FG.

**Tech stack:** Node (ES modules, `node --test`), Express routes, Postgres (`server/src/db.js` `init()` is the schema source of truth), React + Vite in `client/`.

**Worktree:** `~/.config/superpowers/worktrees/ci-erp/parts-plan`. It is a detached checkout of `origin/main` @ `fcfacd6b`. Before Task 1: `cd` there and run `git switch -c feat/carton-made-in-parts`. Every path below is relative to it.

**PROJECT RULE: NOTHING SHIPS.** Per `~/Documents/Projects/Colour Imp Production/CLAUDE.md`:
- No `git commit` and no `git push` (pushing `main` deploys motionci.in).
- No deploy, and no migration or data write on prod.
- Each task ends with a **"Do not commit"** step instead of a commit. Work stays on disk until Anik sanctions shipping in that session.

**Baseline before starting:** `cd server && node --test src/*.test.js 2>&1 | tail -8`. Record `# tests / # pass / # fail`; every later run is judged against that. Never run `node --test src/` (a bare directory boots the API).

---

## What Anik and the floor will see

1. **Product Master → VOGEAB GM2 OUTER → "Made in parts".** Pick Part 1 and Part 2 from this customer's products and save. This is done once per carton.
2. **PO entry is unchanged.** Enter `SW-715 × 11,500`. The part rows never appear in the PO product picker.
3. **Planning** shows two rows, **not** the carton:

   | Product | Board | Board Status |
   |---|---|---|
   | VOGEAB GM2 OUTER – PART 1 · `Part 1 · for SW-715` | Saffire 290 · 20×38 | Stock OK |
   | VOGEAB GM2 OUTER – PART 2 · `Part 2 · for SW-715` | Saffire 290 · 12×18 | Stock Short → Raise PR |

   Each row has its own chip saying **`Carton board: 1 of 2 parts covered`**, so the planner sees the whole carton at a glance. Each part is planned, covered and has its PR raised on **its own board size**, exactly like any other job today.
4. **Job cards:** `CI-JC-A` (Part 1) and `CI-JC-B` (Part 2). Each runs cutting → printing → … → die cutting. Each printed card shows "PART 1 of 2 · for VOGEAB GM2 OUTER · pasted on the carton's pasting card".
5. When **both** are die-cut, **Sort & Paste** gets `CI-JC-C · VOGEAB GM2 OUTER` for `min(Part 1 pieces, Part 2 pieces)` cartons. Its printed card lists the two part cards it joins.
6. Closing it puts **SW-715 cartons** into FG. Dispatch, challan and invoice see only SW-715, as today.

---

## File map

| File | Change | Responsibility |
|---|---|---|
| `supabase/migrations/20260929120000_carton_parts.sql` | create | `product_parts`, `order_lines.part_of_line_id`, `job_cards.is_assembly`, realtime ping |
| `server/src/db.js` | modify (append at end of `init()`) | replay the migration file locally |
| `server/src/carton-parts.js` | create | every PURE rule: routes, join test, sets/spare, sync diff, guards, parts-set validation |
| `server/src/carton-parts.test.js` | create | unit tests for the above |
| `server/src/helpers.js` | modify | `PART_LINES_SQL` + `partLinesOf`; `cardForLine` carries `part_of_line_id`; `splitGangReverseBlock` part/assembly clauses; `createJobCardForLine` part route + carton refusal; rollback guard |
| `server/src/carton-parts-db.js` | create | `syncPartLines`, `closePartCard`, `maybeCreateAssemblyCard` (DB, in the caller's tx) |
| `server/src/routes/product-parts.js` | create | `GET/PUT /products/:id/parts` |
| `server/src/app.js` | modify | mount the router |
| `server/src/routes/masters.js` | modify | `/products/picker` gains `is_part` |
| `server/src/routes/orders.js` | modify | POST/PUT `/orders` sync; line cancel guard + cascade; `LINE_VIEW` part fields; `/planning` hides cartons and keeps parts together; `/sales/pendency` excludes parts and carries `parts`; orders list totals exclude parts |
| `server/src/routes/dispatch.js` | modify | shortage re-raise syncs parts; sales-facing lists exclude part lines |
| `server/src/routes/dashboard.js` | modify | open-line KPIs exclude part lines |
| `server/src/routes/gangs.js` | modify | `MEMBER_VIEW` + refuse part lines in gang / combined run / add-lines |
| `server/src/routes/production.js` | modify | die-cut join branch; pasting card start branch; over-issue alarm skip; `attachCartonParts` on `GET /job-cards/:id` |
| `client/src/lib/cartonParts.js` | create | client twins: `partChipText`, `cartonBoardSummary` |
| `client/src/components/PartChip.jsx` | create | Planning chip |
| `client/src/components/ProductPartsEditor.jsx` | create | "Made in parts" editor |
| `client/src/components/ProductMasterEditor.jsx` | modify | render the editor for an existing product |
| `client/src/components/JobCardPartsBand.jsx` | create | printed job card band |
| `client/src/components/JobCardSheet.jsx` | modify | render the band under the JC number |
| `client/src/pages/Planning.jsx` | modify | chip in the Product cell |
| `client/src/pages/Orders.jsx` | modify | edit form never carries part lines; PO picker hides parts |
| `server/src/carton-parts-pins.test.js` | create | source pins for every wiring task |
| `server/src/carton-parts-flow-pg.test.js` | create | real-Postgres flow, opt-in `CARTON_PARTS_PG=1` |

---

## Design contract (read before any task)

- **C1 — one level only.** An outer carton cannot itself be a part, and a part cannot have parts. A carton has **0 or ≥ 2** parts. Parts belong to the **same customer** as the outer. The same part row may sit under several outers; for example, GM1 and GM2 may share a Part 2.
- **C2 — the carton line carries no board.** Once it has part lines: `sheets_required = parent_sheets_required = wastage_sheets = 0`, and it is hidden from Planning. A carton line that was already `planned` releases its plan-lock holds and returns to `pending` when it is first split. A carton line in a gang, or already `ready` or later, is **not** converted. The sync warns instead.
- **C3 — a part line is an ordinary line.** Values:
  - `rate 0, gst 0`
  - `qty = carton qty × per_carton`
  - `line_remark` = the carton's, because the batch rides there
  - `tolerance_pct` and `delivery_date` = the carton's
  - `part_of_line_id` = the carton line
  - `part_label`, `part_per_carton` = copied from the master when made. The line remembers what it is.
  
  It is created and updated **only** by `syncPartLines`, which runs on order create, on order edit, on shortage re-raise, and when a carton's parts are saved.
- **C4 — part job card = `partStages(routingFor(product))`,** i.e. the route up to and ending at die cutting. Completing its die cutting:
  - sets card `status='split'`, `qty_produced = die-cut sheets × effective ups` (pieces);
  - leaves no FG receipt;
  - leaves the part line `in_production`.
- **C5 — the pasting card is created when EVERY part card is `split`.** Values:
  - `order_line_id` = the carton line, `product_id` = the outer
  - `is_assembly = true`
  - `qty_planned = sheets_issued = min(floor(pieces_i / per_carton_i))`
  - stages = `assemblyStages(routingFor(outer))`

  The carton line walks to `in_production`. Each part line walks `in_production → produced → dispatched` (terminal), so order completion, pendency and dispatch never wait on it. Spare pieces are written to the audit trail only.
- **C6 — nothing else changes.** The pasting card closes through the existing Sort & Paste closer, which credits FG with the outer and marks the carton line `produced`. Dispatch, challan, invoice and FG boxes need no changes.
- **C7 — guards.** Each is a 409 with a plain sentence:
  - a part line cannot be ganged or combined;
  - a part line cannot be cancelled or deleted on its own. Rolling one back rolls back its whole carton, all parts;
  - a carton line cannot be cancelled once any part is past `planned`;
  - the carton line can never get an ordinary job card;
  - the pasting card and a split part card cannot be reversed to Planning, rolled back or deleted.
- **C9 — the freeze.** Once any part line is past `planned`, that carton's parts LIST is frozen for this order.
  - The order's own part lines decide the pasting card and the printed bands, not the live master. Each line remembers its label and pieces per carton; the master fills in only for a line that predates that memory.
  - A part the master has dropped keeps following the carton's qty, sized by its own pieces per carton.
  - Qty and batch still follow onto every part line still in planning.
  - A changed list applies to the next order, or after the carton is rolled back in Planning and saved again.
- **C8 — one way out for a part line.** No FK cascade. `rollbackLine` on a carton first runs `rollbackLine` on each of its parts (`viaCarton: true`), in both `rollback` and `delete` mode. That undoes each part's holds, PR and job card exactly as for any line, under each part's own blockers.
  - Every other path that removes or voids a carton or a part goes through it: order edit removal, whole-order delete (which loops only non-part lines), a carton's first conversion when it already carries a plan, and a part taken off the master.
  - A carton rolled back to `pending` keeps `sheets_required = parent_sheets_required = wastage_sheets = 0`, never NULL, or readiness would price its own master board as demand.

---

### Task 1: Schema

**Files:**
- Create: `supabase/migrations/20260929120000_carton_parts.sql`
- Modify: `server/src/db.js` (end of `init()`, after the `20260928160000_fluence_mrp_changes.sql` replay, currently line 2833)

- [ ] **Step 1: Write the migration**

```sql
-- A carton MADE IN PARTS: one saleable outer carton printed as separate pieces,
-- each on its own sheet and board, die-cut apart and pasted together into one
-- carton at Sort & Paste (VOGEAB GM1/GM2 outers, SW-712/715/716). The PO names
-- only the outer; its parts are ordinary Product Master rows listed here.
--
-- Mirrored locally by server/src/db.js init(), which replays this file — so it
-- must stay idempotent.
--
-- LOCKS: ADD COLUMN with a constant default is catalogue-only (no rewrite), but
-- it holds ACCESS EXCLUSIVE on order_lines and job_cards until commit, and the
-- new foreign keys take SHARE ROW EXCLUSIVE on products (blocks Product Master
-- saves, not order-line FK checks). The unique index build scans order_lines
-- (~1,100 rows: milliseconds). While this waits for job_cards it already holds
-- order_lines, freezing that table's readers — so the timeout is short, and a
-- timeout just rolls the whole file back to be re-run off-shift.
set local lock_timeout = '1s';

CREATE TABLE IF NOT EXISTS product_parts (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  outer_product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  part_product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  -- What the floor calls it: 'Part 1', 'Part 2', 'Top', 'Base'.
  label TEXT NOT NULL,
  -- Pieces of this part in one finished carton (almost always 1).
  per_carton INTEGER NOT NULL DEFAULT 1 CHECK (per_carton >= 1),
  seq INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT product_parts_not_itself CHECK (outer_product_id <> part_product_id),
  CONSTRAINT product_parts_once UNIQUE (outer_product_id, part_product_id)
);
CREATE INDEX IF NOT EXISTS product_parts_outer_idx ON product_parts (outer_product_id, seq);
CREATE INDEX IF NOT EXISTS product_parts_part_idx ON product_parts (part_product_id);

-- A PART LINE: the hidden order line one part of a carton is planned, covered,
-- printed and die-cut on. Points at the carton's own line on the same order.
-- No ON DELETE action, on purpose: a part line leaves only through rollbackLine,
-- called by its carton, so its board holds, PR and job card are undone exactly
-- as any line's are. A path that forgets fails loudly instead of dropping rows.
ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS part_of_line_id INTEGER
  REFERENCES order_lines(id);
-- One line per part per carton. Its leading column also serves every
-- `part_of_line_id = $1` lookup and the foreign-key check on a carton delete.
CREATE UNIQUE INDEX IF NOT EXISTS order_lines_one_line_per_part
  ON order_lines (part_of_line_id, product_id) WHERE part_of_line_id IS NOT NULL;
-- What a part line IS, remembered on the line itself: its floor label and its
-- pieces per carton, copied from the master when the line is made. Once its
-- carton's parts are under way the master may change; the order's own lines
-- keep deciding the pasting card (carton-parts.js contract C9).
ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS part_label TEXT;
ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS part_per_carton INTEGER;

-- The PASTING CARD of a carton made in parts: sorting + pasting only, fed by
-- the part cards' die-cut pieces, never by board.
ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS is_assembly BOOLEAN NOT NULL DEFAULT false;

-- Realtime: same guarded block as 20260918120000_fluence_realtime_ping.sql.
do $$
begin
  if pg_catalog.to_regprocedure('public.ci_erp_realtime_ping()') is null then
    return;
  end if;
  execute 'create or replace trigger ci_erp_realtime_ping after insert or update or delete on public.product_parts for each row execute function public.ci_erp_realtime_ping()';
  execute 'create or replace trigger ci_erp_realtime_ping_truncate after truncate on public.product_parts for each statement execute function public.ci_erp_realtime_ping()';
end
$$;
```

- [ ] **Step 2: Replay it in `init()`.** Append after the `20260928160000_fluence_mrp_changes.sql` line:

```js
  // Cartons made in parts — product_parts, order_lines.part_of_line_id,
  // job_cards.is_assembly (carton-parts.js holds every rule). Idempotent.
  await pool.query(migration('20260929120000_carton_parts.sql'));
```

The replay goes through the simple-query protocol, so the whole file runs as one implicit transaction: `set local` takes effect and ends with it. Even a no-op replay briefly takes ACCESS EXCLUSIVE on both tables. A local boot while another session holds a transaction on either table now fails after 1 s instead of waiting, which is expected.

- [ ] **Step 2b: Create the source-pin file** `server/src/carton-parts-pins.test.js`. Every later task **appends** its pins here, with imports added at the top.

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Source pins for the carton-made-in-parts wiring (plan 2026-09-29): each test
// guards one wiring point the unit tests cannot see. Local databases never have
// the realtime ping function, so the migration's trigger block is pinned here
// or nothing would notice it going missing.
const src = f => readFileSync(new URL(f, import.meta.url), 'utf8');

test('carton-parts migration: plain FK, short lock, realtime ping, replayed by init()', () => {
  const sql = src('../../supabase/migrations/20260929120000_carton_parts.sql');
  assert.match(sql, /set local lock_timeout = '1s';/);
  const col = sql.match(/ADD COLUMN IF NOT EXISTS part_of_line_id[^;]*;/)[0];
  assert.match(col, /REFERENCES order_lines\(id\)/);
  assert.doesNotMatch(col, /ON DELETE/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS order_lines_one_line_per_part/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS part_label TEXT;/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS part_per_carton INTEGER;/);
  assert.match(sql, /to_regprocedure\('public\.ci_erp_realtime_ping\(\)'\) is null/);
  assert.match(sql, /create or replace trigger ci_erp_realtime_ping after insert or update or delete on public\.product_parts for each row/);
  assert.match(sql, /create or replace trigger ci_erp_realtime_ping_truncate after truncate on public\.product_parts for each statement/);
  assert.doesNotMatch(sql, /drop trigger/i);
  assert.match(src('./db.js'), /await pool\.query\(migration\('20260929120000_carton_parts\.sql'\)\);/);
});
```
Run `cd server && node --test src/carton-parts-pins.test.js`. It must PASS.

- [ ] **Step 3: Check the baseline stays fresh.**
  - Run from the repo root: `node scripts/build-baseline.mjs --check`
  - Expected: `unchanged`, exit 0. The baseline extracts only inline `pool.query(\`…\`)` literals, so a `migration('…sql')` replay never changes it, the same as the Fluence files.
  - Do **not** run `db:check -- --baseline`: it structurally cannot pass in this repo ([[ci-erp-baseline-freshness-vs-dbcheck]]).
  - Then prove the replay runs on a real Postgres. Throwaway embedded PG, the same harness as `product-code-routes-pg.test.js`: `init()` twice, then `information_schema` shows the table and the two columns. The one-off script lives in `server/` (embedded-postgres resolves from the script's location); delete it after.

- [ ] **Step 4: Do not commit.**

---

### Task 2: The pure rules

**Files:**
- Create: `server/src/carton-parts.js`
- Test: `server/src/carton-parts.test.js`

- [ ] **Step 1: Write the failing tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  JOIN_STAGES, partStages, assemblyStages, shouldJoinAtDieCut, partPieces, joinableSets,
  walkToInProduction, partsFrozen, partLineSyncPlan, partsChangeBlock, partLineGangBlock,
  cartonLineBlock, partsSetError,
} from './carton-parts.js';
import { routingFor } from './helpers.js';

const ROUTE = [
  { stage: 'cutting', unit: 'sheets' }, { stage: 'printing', unit: 'sheets' },
  { stage: 'die_cutting', unit: 'sheets' }, { stage: 'sorting', unit: 'cartons' },
  { stage: 'pasting', unit: 'cartons' },
];

test('a part runs to die cutting; the pasting card runs sorting + pasting', () => {
  assert.deepEqual(JOIN_STAGES, ['sorting', 'pasting']);
  assert.deepEqual(partStages(ROUTE).map(s => s.stage), ['cutting', 'printing', 'die_cutting']);
  assert.deepEqual(assemblyStages(ROUTE).map(s => s.stage), ['sorting', 'pasting']);
});

test('a part route ENDS at die cutting even if a stage ever follows pasting', () => {
  const withQc = [...ROUTE, { stage: 'qc', unit: 'cartons' }];
  assert.equal(partStages(withQc).at(-1).stage, 'die_cutting');
  assert.throws(() => partStages([{ stage: 'cutting' }, { stage: 'printing' }]), /no die cutting stage/);
});

test('over the real routingFor: the part ends at die cutting and part + pasting cover the route', () => {
  const specs = [{}, { coating: 'Full UV Coating' }, { coating: 'Thermal Lamination (Matte)' },
    { leafing: 1 }, { emboss: 1 }, { coating: 'Full UV Coating', emboss: 1, leafing: 1 }];
  for (const spec of specs) {
    const route = routingFor(spec);
    const part = partStages(route);
    assert.equal(part.at(-1).stage, 'die_cutting', JSON.stringify(spec));
    assert.deepEqual([...part, ...assemblyStages(route)].map(s => s.stage), route.map(s => s.stage), JSON.stringify(spec));
  }
});

test('only the LAST die cutting of a PART line joins', () => {
  assert.equal(shouldJoinAtDieCut({ isLastStage: true, stage: 'die_cutting', partOfLineId: 950 }), true);
  assert.equal(shouldJoinAtDieCut({ isLastStage: true, stage: 'die_cutting', partOfLineId: null }), false);
  assert.equal(shouldJoinAtDieCut({ isLastStage: false, stage: 'die_cutting', partOfLineId: 950 }), false);
  assert.equal(shouldJoinAtDieCut({ isLastStage: true, stage: 'printing', partOfLineId: 950 }), false);
});

test('pieces = die-cut sheets × ups, ups floors at 1', () => {
  assert.equal(partPieces({ dieCutSheets: 1450, ups: 8 }), 11600);
  assert.equal(partPieces({ dieCutSheets: 100, ups: 0 }), 100);
  assert.equal(partPieces({ dieCutSheets: null, ups: 4 }), 0);
});

test('the scarcer part decides the cartons; the rest is spare', () => {
  assert.deepEqual(joinableSets([
    { label: 'Part 1', pieces: 11800, per_carton: 1 },
    { label: 'Part 2', pieces: 11600, per_carton: 1 },
  ]), { sets: 11600, spare: [{ label: 'Part 1', qty: 200 }] });
  assert.deepEqual(joinableSets([
    { label: 'Top', pieces: 1000, per_carton: 1 },
    { label: 'Insert', pieces: 1500, per_carton: 2 },
  ]), { sets: 750, spare: [{ label: 'Top', qty: 250 }] });
  assert.deepEqual(joinableSets([]), { sets: 0, spare: [] });
});

test('a part that made nothing gives 0 cartons — the other part is all spare', () => {
  assert.deepEqual(joinableSets([
    { label: 'Part 1', pieces: 0, per_carton: 1 },
    { label: 'Part 2', pieces: 500, per_carton: 1 },
  ]), { sets: 0, spare: [{ label: 'Part 2', qty: 500 }] });
});

test('the carton line walks to in_production from where it stands', () => {
  assert.deepEqual(walkToInProduction('pending'), ['planned', 'ready', 'in_production']);
  assert.deepEqual(walkToInProduction('planned'), ['ready', 'in_production']);
  assert.deepEqual(walkToInProduction('ready'), ['in_production']);
  assert.deepEqual(walkToInProduction('in_production'), []);
  assert.throws(() => walkToInProduction('cancelled'), /cannot start pasting/);
  assert.throws(() => walkToInProduction('produced'), /The carton line is produced — it cannot start pasting/);
});

const PARTS = [
  { part_product_id: 11, label: 'Part 1', per_carton: 1 },
  { part_product_id: 12, label: 'Part 2', per_carton: 1 },
];
// A part line as partLinesOf() returns it: it remembers its own label and pieces per carton.
const line = (id, product_id, status, qty = 100, line_remark = null, part_per_carton = 1) => {
  const label = product_id === 11 ? 'Part 1' : product_id === 12 ? 'Part 2' : 'Part 2b';
  return { id, product_id, status, qty, line_remark, part_label: label, part_per_carton, label };
};

test('frozen = any part past planning', () => {
  assert.equal(partsFrozen([line(1, 11, 'pending'), line(2, 12, 'planned')]), false);
  assert.equal(partsFrozen([line(1, 11, 'pending'), line(2, 12, 'ready')]), true);
  assert.equal(partsFrozen([]), false);
});

test('sync: a fresh carton line gets one part line per part, qty × per carton', () => {
  const plan = partLineSyncPlan({ outer: { qty: 11500, status: 'pending', line_remark: 'B-7' },
    parts: [PARTS[0], { ...PARTS[1], per_carton: 2 }], existing: [] });
  assert.deepEqual(plan.insert, [
    { product_id: 11, qty: 11500, label: 'Part 1', per_carton: 1 },
    { product_id: 12, qty: 23000, label: 'Part 2', per_carton: 2 },
  ]);
  assert.deepEqual([plan.update, plan.remove, plan.warnings], [[], [], []]);
});

test('sync: a planned carton still syncs; nothing changed means nothing to do', () => {
  assert.equal(partLineSyncPlan({ outer: { qty: 100, status: 'planned' }, parts: PARTS, existing: [] }).insert.length, 2);
  assert.deepEqual(partLineSyncPlan({ outer: { qty: 100, status: 'pending', line_remark: null }, parts: PARTS,
    existing: [line(1, 11, 'planned'), line(2, 12, 'pending')] }), { insert: [], update: [], remove: [], warnings: [] });
});

test('sync: qty and batch follow onto parts still in planning; past it they warn by name', () => {
  const plan = partLineSyncPlan({
    outer: { qty: 12000, status: 'pending', line_remark: 'B-8' }, parts: PARTS,
    existing: [line(1, 11, 'planned', 11500, 'B-7'), line(2, 12, 'in_production', 11500, 'B-7')],
  });
  assert.deepEqual(plan.update, [{ id: 1, qty: 12000, line_remark: 'B-8', label: 'Part 1', per_carton: 1 }]);
  assert.deepEqual(plan.warnings, [
    'Part 2 is already in production for 11500 — its quantity stays; roll it back in Planning to take the new one',
    'Part 2 is already in production with batch B-7 — the new batch B-8 does not reach it; roll it back in Planning to change it',
  ]);
});

test('sync: a batch-only change on a part still in planning is an update', () => {
  const plan = partLineSyncPlan({ outer: { qty: 100, status: 'pending', line_remark: 'B-9' }, parts: PARTS,
    existing: [line(1, 11, 'pending', 100, 'B-7'), line(2, 12, 'pending', 100, 'B-9')] });
  assert.deepEqual(plan.update, [{ id: 1, qty: 100, line_remark: 'B-9', label: 'Part 1', per_carton: 1 }]);
});

test('sync: a part dropped from the master leaves while in planning — pending or planned', () => {
  const plan = partLineSyncPlan({
    outer: { qty: 100, status: 'pending', line_remark: null }, parts: PARTS.slice(0, 1),
    existing: [line(1, 11, 'pending'), line(2, 12, 'planned')],
  });
  assert.deepEqual(plan.remove, [{ id: 2 }]);
  assert.deepEqual(plan.warnings, []);
});

test('sync: once a part is on the floor the parts LIST is frozen — no adds, no removes, one warning', () => {
  // (a) Part 2 replaced by Part 2b on the master while Part 1 is printing
  const swapped = partLineSyncPlan({
    outer: { qty: 100, status: 'pending', line_remark: null },
    parts: [PARTS[0], { part_product_id: 13, label: 'Part 2b', per_carton: 1 }],
    existing: [line(1, 11, 'in_production'), line(2, 12, 'planned')],
  });
  assert.deepEqual([swapped.insert, swapped.remove], [[], []]);
  assert.deepEqual(swapped.warnings,
    ['This carton is already under way as Part 1 + Part 2 — a changed parts list applies from the next order, or after rolling it back in Planning and saving again']);
  // (b) the parts list cleared after Part 1 was die-cut: its lines stay
  const cleared = partLineSyncPlan({ outer: { qty: 100, status: 'pending', line_remark: null }, parts: [],
    existing: [line(1, 11, 'in_production'), line(2, 12, 'in_production')] });
  assert.deepEqual([cleared.insert, cleared.remove, cleared.warnings.length], [[], [], 1]);
});

test('sync: while frozen, a part the master dropped but still in planning keeps following qty and batch', () => {
  const plan = partLineSyncPlan({
    outer: { qty: 12000, status: 'pending', line_remark: 'B-8' }, parts: PARTS.slice(0, 1),
    existing: [line(1, 11, 'in_production', 12000, 'B-8'), line(2, 12, 'planned', 11500, 'B-7')],
  });
  assert.deepEqual(plan.update, [{ id: 2, qty: 12000, line_remark: 'B-8', label: 'Part 2', per_carton: 1 }]);
  assert.deepEqual([plan.insert, plan.remove], [[], []]);
  assert.equal(plan.warnings.length, 1);
  assert.match(plan.warnings[0], /already under way as Part 1 \+ Part 2/);
});

test('sync: a part the master dropped keeps its OWN label and pieces per carton while it follows', () => {
  // not frozen: it follows the carton (qty 150 × its own 2) and is removed; if the
  // removal is refused the kept line is still right-sized
  const plan = partLineSyncPlan({
    outer: { qty: 150, status: 'pending', line_remark: null }, parts: PARTS.slice(0, 1),
    existing: [line(1, 11, 'pending', 150), line(2, 12, 'planned', 200, null, 2)],
  });
  assert.deepEqual(plan.update, [{ id: 2, qty: 300, line_remark: null, label: 'Part 2', per_carton: 2 }]);
  assert.deepEqual(plan.remove, [{ id: 2 }]);
});

test('sync: while nothing is under way, a listed part takes the master\'s new pieces per carton', () => {
  const plan = partLineSyncPlan({
    outer: { qty: 100, status: 'pending', line_remark: null },
    parts: [{ ...PARTS[0], per_carton: 2 }, PARTS[1]],
    existing: [line(1, 11, 'pending'), line(2, 12, 'planned')],
  });
  assert.deepEqual(plan.update, [{ id: 1, qty: 200, line_remark: null, label: 'Part 1', per_carton: 2 }]);
});

test('sync: once frozen, the order\'s own pieces per carton stand even if the master changes', () => {
  const plan = partLineSyncPlan({
    outer: { qty: 100, status: 'pending', line_remark: null },
    parts: [{ ...PARTS[0], per_carton: 2 }, { ...PARTS[1], label: 'Base' }],
    existing: [line(1, 11, 'in_production'), line(2, 12, 'planned')],
  });
  assert.deepEqual(plan, { insert: [], update: [], remove: [], warnings: [] });
});

test('sync: string ids from JSON compare as numbers', () => {
  const plan = partLineSyncPlan({ outer: { qty: 100, status: 'pending', line_remark: null },
    parts: [{ part_product_id: '11', label: 'Part 1', per_carton: 1 }, { part_product_id: '12', label: 'Part 2', per_carton: 1 }],
    existing: [line(1, 11, 'pending'), line(2, 12, 'pending')] });
  assert.deepEqual(plan, { insert: [], update: [], remove: [], warnings: [] });
});

test('sync: a carton line past planning is never touched', () => {
  const plan = partLineSyncPlan({ outer: { qty: 100, status: 'in_production' }, parts: PARTS, existing: [] });
  assert.deepEqual(plan, { insert: [], update: [], remove: [], warnings: [] });
});

test('change guard: a part never moves alone; a carton not once a part is past planning', () => {
  assert.match(partsChangeBlock({ part_of_line_id: 950 }), /one part of a carton made in parts — cancel or remove the carton, not its part/);
  assert.match(partsChangeBlock({ id: 950 }, [{ label: 'Part 2', status: 'ready' }]),
    /Part 2 of this carton is already ready — roll it back in Planning first/);
  assert.match(partsChangeBlock({ id: 950 }, [{ label: 'Part 1', status: 'in_production' }]), /already in production/);
  assert.match(partsChangeBlock({ id: 950 }, [{ label: 'Part 1', status: 'dispatched' }]),
    /Part 1 of this carton is already pasted — the carton cannot be cancelled/);
  assert.equal(partsChangeBlock({ id: 950 }, [{ label: 'Part 1', status: 'planned' }]), null);
  assert.equal(partsChangeBlock({ id: 950 }, [{ label: 'Part 1', status: 'pending' }]), null);
  assert.equal(partsChangeBlock({ id: 1 }, []), null);
});

test('gang guard names the part — and the carton itself', () => {
  assert.match(partLineGangBlock([{ product_name: 'X' }, { product_name: 'GM2 P1', part_of_line_id: 9 }]),
    /GM2 P1 is one part of a carton made in parts — it runs on its own job card, never in a gang or combined run/);
  assert.match(partLineGangBlock([{ product_name: 'GM2 OUTER', has_parts: true }, { product_name: 'X' }]),
    /GM2 OUTER is made in parts — its parts run on their own job cards/);
  assert.equal(partLineGangBlock([{ product_name: 'X' }]), null);
});

test('carton line guard — and a part at the FG doors', () => {
  assert.match(cartonLineBlock({ hasParts: true }), /made in parts — plan, cover and fill its parts, not the carton itself/);
  assert.match(cartonLineBlock({ isPart: true }), /one part of a carton made in parts — its pieces come from its own job card, never from FG stock/);
  assert.equal(cartonLineBlock({ hasParts: false }), null);
  assert.equal(cartonLineBlock({}), null);
});

test('parts set: 0 or ≥2 parts, same customer, one level, clean labels — each refusal names its row', () => {
  const outer = { id: 1, customer_id: 5 };
  const products = new Map([[11, { id: 11, customer_id: 5 }], [12, { id: 12, customer_id: 5 }], [13, { id: 13, customer_id: 6 }]]);
  const ok = { outer, products, outerIsPart: false, partsWithParts: [] };
  assert.equal(partsSetError({ ...ok, parts: [] }), null);
  assert.equal(partsSetError({ ...ok, parts: PARTS }), null);
  assert.equal(partsSetError({ ...ok, parts: PARTS.map(p => ({ ...p, part_product_id: String(p.part_product_id) })) }), null);
  assert.match(partsSetError({ ...ok, parts: PARTS.slice(0, 1) }), /at least two parts/);
  assert.match(partsSetError({ ...ok, parts: [PARTS[0], { part_product_id: 13, label: 'P', per_carton: 1 }] }),
    /^P: every part must belong to the same customer/);
  assert.match(partsSetError({ ...ok, parts: [PARTS[0], { ...PARTS[1], label: 'part 1' }] }), /^part 1: two parts have the same label/);
  assert.match(partsSetError({ ...ok, parts: [PARTS[0], { ...PARTS[1], part_product_id: 1 }] }), /^Part 2: a carton cannot be a part of itself/);
  assert.match(partsSetError({ ...ok, parts: [PARTS[0], { ...PARTS[1], per_carton: 0 }] }), /^Part 2: pieces per carton/);
  assert.match(partsSetError({ ...ok, parts: [PARTS[0], { ...PARTS[1], part_product_id: 11 }] }), /^Part 2: the same product is listed twice/);
  assert.match(partsSetError({ ...ok, parts: [PARTS[0], { ...PARTS[1], part_product_id: 99 }] }), /^Part 2: that product is not in the Product Master/);
  assert.match(partsSetError({ ...ok, parts: [PARTS[0], { ...PARTS[1], part_product_id: '' }] }), /^Part 2: pick the part's product/);
  assert.match(partsSetError({ ...ok, parts: [PARTS[0], { ...PARTS[1], label: '' }] }), /^Row 2: give the part a label/);
  assert.match(partsSetError({ ...ok, outerIsPart: true, parts: PARTS }), /is itself a part of another carton/);
  assert.match(partsSetError({ ...ok, partsWithParts: ['12'], parts: PARTS }), /^Part 2: that product has parts of its own/);
});
```

- [ ] **Step 2: Confirm it fails.**
  - Run: `cd server && node --test src/carton-parts.test.js`
  - Expected: FAIL, `Cannot find module './carton-parts.js'`.

`carton-parts.js` imports only `./stage-runs.js`, which itself has no imports. That is what lets `helpers.js` import this module without a cycle. The test imports `routingFor` from `./helpers.js` to pin the part route against the real routing.

- [ ] **Step 3: Implement `server/src/carton-parts.js`**

```js
// A carton MADE IN PARTS — one saleable outer carton printed as separate pieces,
// each on its own sheet and board, die-cut apart and pasted together into one
// carton at Sort & Paste (VOGEAB GM1/GM2 outers). The PO names only the carton;
// every rule about its parts lives here, pure, so each one is a unit test.
//
//   carton line (the PO line)   — carries no board, hidden from Planning
//     ├─ part line  Part 1      — planned, covered and printed like any job on
//     └─ part line  Part 2        ITS OWN board, ending at die cutting
//   pasting card (is_assembly)  — sorting + pasting, made once EVERY part is
//                                 die-cut; closing it credits FG with the carton
//
// The DB side is carton-parts-db.js; the guards are called from the routes.
// The only import is stage-runs.js, itself import-free — so helpers.js can
// import this module without a cycle.
import { toStageUnit } from './stage-runs.js';

const n = v => Math.max(0, Math.round(+v || 0));
const per = p => Math.max(1, n(p?.per_carton) || 1);
const said = s => String(s || '').replace(/_/g, ' ');
const id = v => Number(v);

// The stages that belong to the finished carton, not to a piece of it.
export const JOIN_STAGES = ['sorting', 'pasting'];

// A part's own route: everything up to AND ENDING AT die cutting — never "the
// route minus sorting and pasting", or a stage added after pasting (a QC hop,
// say) would become the part card's last stage, the die-cut join would never
// fire, and the ordinary closer would credit FG with the part itself.
export function partStages(routing) {
  const end = routing.findIndex(s => s.stage === 'die_cutting');
  if (end < 0) throw Object.assign(new Error('A part must be die-cut — its route has no die cutting stage'), { status: 409 });
  return routing.slice(0, end + 1);
}

// The pasting card's route — the same two stages a split gang child runs.
export const assemblyStages = routing => routing.filter(s => JOIN_STAGES.includes(s.stage));

// Completing this stage finishes a PART: its route's last stage, die cutting,
// on a line that belongs to a carton.
export function shouldJoinAtDieCut({ isLastStage, stage, partOfLineId }) {
  return !!(isLastStage && stage === 'die_cutting' && partOfLineId);
}

// Pieces a part card made: die-cut sheets × ups — the same sheets→cartons
// conversion every Sorting receipt uses (stage-runs.js toStageUnit).
export const partPieces = ({ dieCutSheets, ups }) =>
  toStageUnit({ prevQtyOut: dieCutSheets, prevUnit: 'sheets', unit: 'cartons', ups }) ?? 0;

// Cartons the parts make together — the scarcest part decides — and what each
// part has left over. Zero is an answer, not an error: a pasting card for 0
// closes short at Sort & Paste, and the shortage re-raise brings the carton
// (and its parts) back — the same road any short job takes.
export function joinableSets(parts = []) {
  if (!parts.length) return { sets: 0, spare: [] };
  const sets = Math.min(...parts.map(p => Math.floor(n(p.pieces) / per(p))));
  return {
    sets,
    spare: parts.map(p => ({ label: p.label, qty: n(p.pieces) - sets * per(p) })).filter(s => s.qty > 0),
  };
}

// The statuses a carton line steps through to in_production, one allowed
// transition at a time (LINE_TRANSITIONS in helpers.js). A carton never gets
// a card from Planning, so it may still be pending when its last part is cut.
const WALK = ['pending', 'planned', 'ready', 'in_production'];
export function walkToInProduction(status) {
  const i = WALK.indexOf(status);
  if (i < 0) throw Object.assign(new Error(`The carton line is ${said(status)} — it cannot start pasting`), { status: 409 });
  return WALK.slice(i + 1);
}

// A part line the planner can still change: nothing of it is on the floor.
export const EDITABLE_PART = ['pending', 'planned'];

// Once ANY part is past planning, the carton is physically being made as the
// parts on this order — the parts LIST is frozen for it. (The carton line
// itself stays pending until its pasting card exists, so its own status can
// never say this.)
export const partsFrozen = partLines => partLines.some(p => !EDITABLE_PART.includes(p.status));

// What keeping a carton line's part lines in step should do. Pure diff:
//   outer    { qty, status, line_remark }
//   parts    [{ part_product_id, label, per_carton }] from product_parts
//   existing [{ id, product_id, qty, status, line_remark, part_label,
//             part_per_carton, label }] the carton's part lines (partLinesOf) —
//             each REMEMBERS its own label and pieces per carton
// Every part line ON THE ORDER still in planning follows the carton's qty and
// batch — including one the master has dropped, sized by its own remembered
// pieces per carton. What a part IS (label, pieces per carton) follows the
// master only while the part is listed and nothing is under way; once the list
// is frozen, or once the master drops the part, the line's own figures stand.
// The LIST follows the master (adds, removes) only while no part is under way;
// after that a changed list is one warning.
export const SYNCABLE_OUTER = ['pending', 'planned'];
export function partLineSyncPlan({ outer, parts = [], existing = [] }) {
  const plan = { insert: [], update: [], remove: [], warnings: [] };
  if (!SYNCABLE_OUTER.includes(outer.status)) return plan;
  const remark = outer.line_remark ?? null;
  const frozen = partsFrozen(existing);
  const listed = new Set(parts.map(p => id(p.part_product_id)));
  for (const line of existing) {
    const p = parts.find(x => id(x.part_product_id) === id(line.product_id));
    const master = !frozen && p;                 // the master speaks for this part
    const label = master ? p.label : (line.part_label ?? line.label);
    const perCarton = master ? per(p) : (n(line.part_per_carton) || per(p));
    const qty = n(outer.qty) * perCarton;
    const qtyMoved = n(line.qty) !== qty;
    const batchMoved = (line.line_remark ?? null) !== remark;
    const whatMoved = (line.part_label ?? null) !== label || n(line.part_per_carton) !== perCarton;
    if (!qtyMoved && !batchMoved && !whatMoved) continue;
    if (EDITABLE_PART.includes(line.status)) {
      plan.update.push({ id: line.id, qty, line_remark: remark, label, per_carton: perCarton });
      continue;
    }
    if (qtyMoved) plan.warnings.push(`${label} is already ${said(line.status)} for ${line.qty} — its quantity stays; roll it back in Planning to take the new one`);
    if (batchMoved) plan.warnings.push(`${label} is already ${said(line.status)} with batch ${line.line_remark ?? 'none'} — the new batch ${remark ?? 'none'} does not reach it; roll it back in Planning to change it`);
  }
  if (!frozen) {
    for (const p of parts) {
      if (!existing.some(e => id(e.product_id) === id(p.part_product_id)))
        plan.insert.push({ product_id: id(p.part_product_id), qty: n(outer.qty) * per(p), label: p.label, per_carton: per(p) });
    }
    for (const line of existing) if (!listed.has(id(line.product_id))) plan.remove.push({ id: line.id });
  }
  const onOrder = new Set(existing.map(e => id(e.product_id)));
  const differs = listed.size !== onOrder.size || [...listed].some(x => !onOrder.has(x));
  if (frozen && differs) {
    plan.warnings.push(`This carton is already under way as ${existing.map(e => e.part_label ?? e.label).join(' + ')} — a changed parts list applies from the next order, or after rolling it back in Planning and saving again`);
  }
  return plan;
}

// Why this line cannot be cancelled (or, for a part, cancelled or removed on its
// own), or null. partLines: the carton's part lines, each with a label
// (partLinesOf()). A part still pending or planned cancels with its carton —
// setLineStatus releases a planned part's holds on the way.
export const CANCELLABLE_PART = ['pending', 'planned'];
export function partsChangeBlock(line, partLines = []) {
  if (line?.part_of_line_id)
    return 'This is one part of a carton made in parts — cancel or remove the carton, not its part';
  const busy = partLines.find(p => !CANCELLABLE_PART.includes(p.status));
  if (!busy) return null;
  return busy.status === 'dispatched'
    ? `${busy.label} of this carton is already pasted — the carton cannot be cancelled`
    : `${busy.label} of this carton is already ${said(busy.status)} — roll it back in Planning first`;
}

// Why these lines cannot run as a gang or a combined run, or null. A part ends
// at die cutting on its own card, and a carton made in parts has no sheet of
// its own — a gang child or a combined run would credit FG with the wrong thing.
export function partLineGangBlock(members = []) {
  const part = members.find(m => m.part_of_line_id);
  if (part) return `${part.product_name} is one part of a carton made in parts — it runs on its own job card, never in a gang or combined run`;
  const carton = members.find(m => m.has_parts);
  if (carton) return `${carton.product_name} is made in parts — its parts run on their own job cards, never in a gang or combined run`;
  return null;
}

// Why this line cannot be planned, covered, raised for or filled from stock
// through a single-line Planning/FG door, or null.
//   hasParts — a CARTON made in parts: no board and no card of its own; its
//              parts are planned, covered and filled instead.
//   isPart   — pass at the two FG doors only (consume-fg, fulfil-from-stock): a
//              part's pieces come from its own job card; FG booked against a
//              part would leave the pasting join waiting for a card forever.
export function cartonLineBlock({ hasParts = false, isPart = false }) {
  if (hasParts) return 'This carton is made in parts — plan, cover and fill its parts, not the carton itself';
  if (isPart) return 'This is one part of a carton made in parts — its pieces come from its own job card, never from FG stock';
  return null;
}

// Why this parts list cannot be saved on this carton, or null. Each refusal
// names the row, since the Product Master editor shows a list.
//   outer          { id, customer_id }
//   parts          [{ part_product_id, label, per_carton }]
//   products       Map id(number) → { id, customer_id } for every part_product_id
//   outerIsPart    the outer already sits under another carton
//   partsWithParts part ids that are cartons-in-parts themselves
export function partsSetError({ outer, parts = [], products, outerIsPart, partsWithParts = [] }) {
  if (!parts.length) return null; // clearing the list is always allowed
  if (parts.length < 2) return 'A carton made in parts needs at least two parts — or none';
  if (outerIsPart) return 'This product is itself a part of another carton — a part cannot have parts';
  const nested = new Set(partsWithParts.map(id));
  const labels = new Set();
  const ids = new Set();
  for (const [i, p] of parts.entries()) {
    const row = String(p.label || '').trim() || `Row ${i + 1}`;
    const pid = id(p.part_product_id);
    if (!Number.isInteger(pid) || pid <= 0) return `${row}: pick the part's product`;
    if (pid === id(outer.id)) return `${row}: a carton cannot be a part of itself`;
    const prod = products.get(pid);
    if (!prod) return `${row}: that product is not in the Product Master`;
    if (id(prod.customer_id) !== id(outer.customer_id)) return `${row}: every part must belong to the same customer as the carton`;
    if (nested.has(pid)) return `${row}: that product has parts of its own — only one level is allowed`;
    if (ids.has(pid)) return `${row}: the same product is listed twice`;
    ids.add(pid);
    const label = String(p.label || '').trim().toLowerCase();
    if (!label) return `${row}: give the part a label (Part 1, Part 2 …)`;
    if (labels.has(label)) return `${row}: two parts have the same label`;
    labels.add(label);
    if (!Number.isInteger(Number(p.per_carton)) || Number(p.per_carton) < 1) return `${row}: pieces per carton must be a whole number, 1 or more`;
  }
  return null;
}
```

- [ ] **Step 4: Confirm it passes.**
  - Run: `cd server && node --test src/carton-parts.test.js`
  - Expected: PASS, 25 tests.

- [ ] **Step 5: Do not commit.**

---

### Task 3: DB helpers in `helpers.js` (part-line read, reverse/rollback guards, job card route)

**Files:**
- Modify: `server/src/helpers.js`. Anchors:
  - `cardForLine` at 3590
  - `splitGangReverseBlock` at 3606
  - `createJobCardForLine` at 3710
  - `rollbackLine` at 4836
- Test: `server/src/carton-parts-pins.test.js` (append; created in Task 1)

- [ ] **Step 1: Write the failing source pins.** Add `import { splitGangReverseBlock } from './helpers.js';` to the top of `carton-parts-pins.test.js`, then append:

```js
const helpers = src('./helpers.js');

test('the reverse block covers a finished part and the pasting card', () => {
  assert.match(splitGangReverseBlock({ jc_number: 'CI-JC-1', status: 'split', part_of_line_id: 950 }),
    /CI-JC-1 is a finished part/);
  assert.match(splitGangReverseBlock({ jc_number: 'CI-JC-2', status: 'in_progress', is_assembly: true }),
    /pastes parts made on other job cards/);
  // the gang wording is untouched
  assert.match(splitGangReverseBlock({ jc_number: 'CI-JC-3', status: 'split' }), /was split into one card per job/);
});

test('cardForLine carries part_of_line_id; part cards take the part route; a carton never gets a plain card', () => {
  assert.match(helpers, /jol\.part_of_line_id/);
  assert.match(helpers, /line\.part_of_line_id \? partStages\(routingFor\(product\)\) : routingFor\(product\)/);
  assert.match(helpers, /is made in parts — push its parts/);
});

test('rollbackLine: a part never moves alone; a carton takes each part through rollbackLine first', () => {
  assert.match(helpers, /scopeLineIds = null, viaCarton = false \}/);
  assert.match(helpers, /if \(peek\?\.part_of_line_id && !viaCarton\)/);
  assert.match(helpers, /const out = await rollbackLine\(\{ lineId: peek\.part_of_line_id, mode, note: /);
  assert.match(helpers, /Rolling back a part rolls back its whole carton — /);
  // a carton is locked NO KEY UPDATE — its parts' foreign keys share-lock it
  assert.match(helpers, /line: peek\?\.has_parts \? 'NO KEY UPDATE' : 'UPDATE'/);
  assert.match(helpers, /for \(const part of \[\.\.\.parts\]\.sort\(\(a, b\) => a\.id - b\.id\)\) \{[\s\S]{0,80}await rollbackLine\(\{[^}]*viaCarton: true \}, qc, oc, user\);[\s\S]{0,400}\$\{part\.label\}: \$\{b\}/);
  assert.match(helpers, /if \(mode === 'rollback' && parts\.length\)/);
});
```

- [ ] **Step 2: Confirm it fails.**
  - Run: `cd server && node --test src/carton-parts-pins.test.js`
  - Expected: FAIL.

- [ ] **Step 3: Implement.**

(a) Add the import near the other local imports at the top:
```js
import { partStages, partsChangeBlock } from './carton-parts.js';
```
`carton-parts.js` imports only `stage-runs.js`, which has none, so this cannot form a cycle.

(b) Directly above `cardForLine`, add:
```js
// A carton line's part lines, each with its floor label — the one spelling,
// shared by the rollback guard, the cancel route and syncPartLines.
export const PART_LINES_SQL = `
  SELECT pl.id, pl.product_id, pl.qty, pl.status, pl.line_remark, pl.part_label, pl.part_per_carton,
         COALESCE(pl.part_label, pp.label, p.name) AS label
  FROM order_lines pl
  JOIN order_lines ol ON ol.id = pl.part_of_line_id
  JOIN products p ON p.id = pl.product_id
  LEFT JOIN product_parts pp ON pp.outer_product_id = ol.product_id AND pp.part_product_id = pl.product_id
  WHERE pl.part_of_line_id = $1
  ORDER BY pp.seq NULLS LAST, pl.id`;
export const partLinesOf = (lineId, qc = q) => qc(PART_LINES_SQL, [lineId]);
```

(c) In `cardForLine`, widen `cols` so each card knows whether its line is a part:
```js
  const cols = `jc.*, pj.jc_number AS parent_jc_number, jol.part_of_line_id
    FROM job_cards jc LEFT JOIN job_cards pj ON pj.id=jc.parent_job_card_id
    LEFT JOIN order_lines jol ON jol.id=jc.order_line_id`;
```

(d) In `splitGangReverseBlock`, insert **before** the `if (isSplitChild(jc))` clause:
```js
  // A carton made in parts (carton-parts.js). A finished part's pieces already
  // wait for — or sit on — the carton's pasting card; the pasting card's
  // cartons were printed and die-cut on the part cards. Neither can walk back
  // to Planning on its own.
  if (jc?.part_of_line_id && jc.status === 'split') {
    return `${jc.jc_number} is a finished part — its pieces wait for, or are already on, the carton's pasting card, `
      + 'so it cannot be reversed to Planning, rolled back or deleted. A wrong die-cut count on it needs an admin correction.';
  }
  if (jc?.is_assembly) {
    return `${jc.jc_number} pastes parts made on other job cards — it cannot be reversed to Planning, `
      + 'rolled back or deleted. '
      + (jc.status === 'closed'
        ? 'It is finished — to correct it, use Reverse on its completed run at Sort & Paste.'
        : 'To redo its sorting or pasting, use Send back at Sort & Paste.');
  }
```

(e) In `createJobCardForLine`:
- Right after the `existing` job card check, add:
```js
  // A carton made in parts never gets a card of its own from Planning: its
  // parts are pushed, and its pasting card is made by itself when the last
  // part is die-cut (carton-parts-db.js maybeCreateAssemblyCard).
  if ((await partLinesOf(line.id, qc)).length) {
    const e = new Error('This carton is made in parts — push its parts; the pasting card is created by itself when every part is die-cut');
    e.status = 409;
    throw e;
  }
```
- Replace `const stages = routingFor(product);` with:
```js
  // A part of a carton ends at die cutting; sorting + pasting belong to the carton.
  const stages = line.part_of_line_id ? partStages(routingFor(product)) : routingFor(product);
```

(f) **`rollbackLine`: one way out for a part line (contract C8).** Change the signature to add `viaCarton = false`:
```js
export async function rollbackLine({ lineId, mode = 'rollback', note = null, force = false, scopeLineIds = null, viaCarton = false }, qc = q, oc = one, user = null) {
```
- As the very FIRST statements of the body, before `lockLineGangFirst`, add the peek. Then change the `lockLineGangFirst` call's line mode:
```js
  // Peeked before any lock (carton-parts.js contract C8):
  //   • a PART never moves alone — rolling one back rolls back its whole carton
  //     (Planning shows only the parts, so this is how a planner undoes a
  //     carton); deleting one alone is refused;
  //   • a CARTON is locked FOR NO KEY UPDATE, never FOR UPDATE: every second
  //     update of one of its parts re-checks part_of_line_id and share-locks the
  //     carton, and FOR UPDATE would deadlock against it — the gang row's rule.
  const peek = await oc(`SELECT ol.part_of_line_id,
      EXISTS (SELECT 1 FROM order_lines x WHERE x.part_of_line_id = ol.id) AS has_parts
    FROM order_lines ol WHERE ol.id=$1`, [lineId]);
  if (peek?.part_of_line_id && !viaCarton) {
    if (mode === 'delete') {
      const msg = partsChangeBlock(peek);
      const e = new Error(msg);
      e.status = 409; e.blockers = [msg];
      throw e;
    }
    // Say so — the planner clicked ONE part and the whole carton goes back.
    const why = 'Rolling back a part rolls back its whole carton — ';
    try {
      const out = await rollbackLine({ lineId: peek.part_of_line_id, mode, note: note || `from its part line #${lineId}`, force, scopeLineIds }, qc, oc, user);
      const parts = await partLinesOf(peek.part_of_line_id, qc);
      return { ...out, carton_line_id: peek.part_of_line_id,
        message: `${why}${parts.map(p => p.label).join(' + ')} returned to the sales order` };
    } catch (e) {
      if (e.blockers) {
        e.message = why + e.message;
        e.blockers = e.blockers.map(b => why + b);
        if (e.body?.blockers) e.body = { ...e.body, blockers: e.blockers };
      }
      throw e;
    }
  }
```
Then the existing lock line becomes:
```js
  const line = await lockLineGangFirst(lineId, qc, oc, { gang: 'NO KEY UPDATE', line: peek?.has_parts ? 'NO KEY UPDATE' : 'UPDATE' });
```
Update the pin in `server/src/gang-lock-order.test.js` (~132) from `\{ gang: 'NO KEY UPDATE', line: 'UPDATE' \}` to `\{ gang: 'NO KEY UPDATE', line: peek\?\.has_parts \? 'NO KEY UPDATE' : 'UPDATE' \}`. That changes the pinned text; it doesn't weaken the rule, since the gang is still taken first, NO KEY UPDATE. The final DELETE of a carton upgrades its row lock, and by then its parts are gone in this same transaction.
- Directly after the blockers check (`if (blockers.length) { … throw e; }`) and before `// 1. Release any planning-time FG reservation.`, add:
```js
  // A CARTON made in parts takes its parts with it — each through this same
  // function, so every part's holds, PR and job card are undone exactly as any
  // line's are, under each part's own blockers. First, because the carton row
  // cannot be deleted while a part still points at it (no FK cascade, on
  // purpose). One transaction: a blocked part rolls the whole call back.
  // A refusal below is a plain throw: it undoes the parts already rolled back
  // only because every caller lets it abort the transaction.
  const parts = await partLinesOf(lineId, qc);
  const partNote = `its carton line #${lineId} was ${mode === 'delete' ? 'deleted' : 'rolled back'}${note ? ` — ${note}` : ''}`;
  // Ascending id, like every other multi-line lock.
  for (const part of [...parts].sort((a, b) => a.id - b.id)) {
    try {
      await rollbackLine({ lineId: part.id, mode, note: partNote, force, scopeLineIds, viaCarton: true }, qc, oc, user);
    } catch (e) {
      // Name the part the refusal is about: "Part 2: Cutting is in progress — …".
      if (e.blockers) {
        e.message = `${part.label}: ${e.message}`;
        e.blockers = e.blockers.map(b => `${part.label}: ${b}`);
        if (e.body?.blockers) e.body = { ...e.body, blockers: e.blockers };
      }
      throw e;
    }
  }
```
- Directly after the step-6 `UPDATE order_lines SET machine_id=NULL, … WHERE id=$1` statement, add:
```js
  // A carton made in parts carries no board of its own — its parts do. Held at
  // zero, never NULL, or readiness would price the carton's own master board as
  // demand once the carton reaches pasting (carton-parts.js contract C2).
  if (mode === 'rollback' && parts.length) {
    await qc('UPDATE order_lines SET sheets_required=0, parent_sheets_required=0, wastage_sheets=0 WHERE id=$1', [lineId]);
  }
```
Under `mode === 'delete'` the parts are already gone by then, and the carton row is deleted a few lines later.

(g) **Verify every `splitGangReverseBlock` caller passes a `cardForLine` row.** Run `grep -n "splitGangReverseBlock(" server/src/helpers.js server/src/routes/*.js`. There are 3 callers: `routes/workflow.js:65`, `helpers.js:4644`, `helpers.js:4850`. For each, trace where its `jc` / `card` comes from. If one reads the card some other way, add `jol.part_of_line_id` to that SELECT with the same `LEFT JOIN order_lines jol ON jol.id=jc.order_line_id`.

- [ ] **Step 4: Confirm the tests pass.**
  - Run: `cd server && node --test src/carton-parts-pins.test.js src/carton-parts.test.js`
  - Expected: PASS.
  - Then run the full suite. Expected: baseline counts plus the new tests, 0 new failures.

- [ ] **Step 5: Do not commit.**

---

### Task 4: `carton-parts-db.js`: sync, part close, pasting card

**Files:**
- Create: `server/src/carton-parts-db.js`
- Test: covered by Task 11's PG flow; pins added here

- [ ] **Step 1: Add the failing pins** to `carton-parts-pins.test.js`:

```js
test('carton-parts-db holds the three DB doors, removes through rollbackLine, never credits FG', () => {
  const db = src('./carton-parts-db.js');
  for (const fn of ['syncPartLines', 'closePartCard', 'maybeCreateAssemblyCard'])
    assert.match(db, new RegExp(`export async function ${fn}\\(`));
  assert.doesNotMatch(db, /fgReceipt/);
  assert.doesNotMatch(db, /DELETE FROM order_lines/);
  // rollbackLine's lock rule: NO KEY UPDATE once a line has parts, FOR UPDATE before
  assert.match(db, /FROM order_lines WHERE id=\$1 FOR \$\{peek\.has_parts \? 'NO KEY UPDATE' : 'UPDATE'\}/);
  // the pasting join only ever runs on a carton that has parts
  assert.match(db, /FROM order_lines WHERE id=\$1 FOR NO KEY UPDATE', \[outerLineId\]\);\s*\n\s*if \(!outer\) return null;/);
  assert.match(db, /rollbackLine\(\{ lineId: rm\.id, mode: 'delete'[^}]*viaCarton: true \}/);
  assert.match(db, /rollbackLine\(\{ lineId: outer\.id, mode: 'rollback'/);
  assert.match(db, /sheets_required=NULL, parent_sheets_required=NULL, wastage_sheets=NULL WHERE id=\$1/);
  assert.match(db, /status='split'/);
  assert.match(db, /is_assembly\)\s*\n?\s*VALUES/);
  // the pasting card is decided by the carton's own part lines, never the live master
  assert.match(db, /FROM order_lines pl\s*\n\s*JOIN products p ON p\.id = pl\.product_id\s*\n\s*LEFT JOIN product_parts pp/);
  // an ordinary line leaves after one unlocked look
  assert.match(db, /if \(!peek \|\| peek\.part_of_line_id \|\| \(!peek\.has_parts && !peek\.listed\)\) return out;/);
  // FG reserved or a shipped balance also converts through rollbackLine
  assert.match(db, /\+outer\.fg_consumed_qty > 0 \|\| \+outer\.dispatched_qty > 0/);
  assert.match(db, /SAVEPOINT carton_parts_convert/);
  // the LIST changes all-or-nothing per carton line — never half an old list and half a new one
  assert.match(db, /SAVEPOINT carton_parts_list/);
  // a part line remembers what it is; the pasting join reads the line first
  assert.match(db, /line_remark, part_of_line_id, part_label, part_per_carton\)/);
  assert.match(db, /COALESCE\(pl\.part_per_carton, pp\.per_carton, 1\) AS per_carton/);
  assert.match(db, /The parts list stays as it was on this order — /);
  // pasting card: the order and the product before the carton
  assert.match(db, /FOR KEY SHARE', \[ref\.order_id\]\);\s*\n\s*await oc\('SELECT id FROM products WHERE id=\$1 FOR KEY SHARE', \[ref\.product_id\]\);\s*\n\s*const outer = await oc\('SELECT \* FROM order_lines WHERE id=\$1 FOR NO KEY UPDATE'/);
  assert.doesNotMatch(db, /FROM product_parts pp\s*\n\s*LEFT JOIN order_lines/);
});
```

- [ ] **Step 2: Confirm it fails.**
  - Run: `cd server && node --test src/carton-parts-pins.test.js`
  - Expected: FAIL, `ENOENT carton-parts-db.js`.

- [ ] **Step 3: Implement `server/src/carton-parts-db.js`**

```js
// The DB side of a carton made in parts (rules: carton-parts.js). Every function
// runs inside the CALLER's transaction — qc/oc are its query functions.
import {
  audit, effectiveProduct, nextNumber, partLinesOf, rollbackLine, routingFor, setLineStatus,
} from './helpers.js';
import {
  assemblyStages, joinableSets, partLineSyncPlan, partPieces, walkToInProduction,
} from './carton-parts.js';

const NOTHING = () => ({ inserted: 0, updated: 0, removed: 0, warnings: [] });

// Keep a carton line's part lines in step with its master's parts list. Called
// after an order line is created or edited, after a shortage balance is raised,
// and when a carton's parts are saved. A line whose product has no parts and no
// part lines is left exactly as it was.
export async function syncPartLines(outerLineId, qc, oc, user = null) {
  const out = NOTHING();
  // One unlocked look first: every line of every PO save comes through here, and
  // an ordinary line (no parts on its master, none on the order) is left exactly
  // as it was — no lock, no further query.
  const peek = await oc(`SELECT ol.part_of_line_id,
      EXISTS (SELECT 1 FROM order_lines x WHERE x.part_of_line_id = ol.id) AS has_parts,
      EXISTS (SELECT 1 FROM product_parts pp WHERE pp.outer_product_id = ol.product_id) AS listed
    FROM order_lines ol WHERE ol.id=$1`, [outerLineId]);
  if (!peek || peek.part_of_line_id || (!peek.has_parts && !peek.listed)) return out;
  // rollbackLine's lock rule: a line that already has part lines is locked NO
  // KEY UPDATE (its parts' foreign keys share-lock it on every second update of
  // a part — FOR UPDATE would deadlock); one with none yet is locked FOR UPDATE,
  // which the first-conversion rollbackLine below re-enters without an upgrade.
  const outer = await oc(`SELECT * FROM order_lines WHERE id=$1 FOR ${peek.has_parts ? 'NO KEY UPDATE' : 'UPDATE'}`, [outerLineId]);
  if (!outer || outer.part_of_line_id) return out;
  const parts = await qc(
    `SELECT part_product_id, label, per_carton FROM product_parts
      WHERE outer_product_id=$1 ORDER BY seq, id`, [outer.product_id]);
  const existing = await partLinesOf(outer.id, qc);
  if (!parts.length && !existing.length) return out;

  // First time this line becomes a carton-in-parts: its own board plan is void —
  // each part carries its own board now (contract C2).
  if (parts.length && !existing.length) {
    if (outer.gang_run_id) {
      out.warnings.push('This line is in a gang — take it out of the gang to run it in parts');
      return out;
    }
    if (!['pending', 'planned'].includes(outer.status)) {
      out.warnings.push(`This line is already ${outer.status.replace(/_/g, ' ')} — it runs as one carton this time`);
      return out;
    }
    // Anything already done for the carton as ONE job — a lock, a PR, a hold, a
    // mix, FG reserved against it, a shipped balance (even on a pending line:
    // Raise PR and consume-FG have no status gate) — is undone the one audited
    // way: rollbackLine. It gives reserved FG back, and refuses a shipped line.
    const prior = await oc(`SELECT
        EXISTS (SELECT 1 FROM requisitions WHERE order_line_id=$1) AS pr,
        EXISTS (SELECT 1 FROM board_allocations WHERE order_line_id=$1 AND status='active') AS hold,
        EXISTS (SELECT 1 FROM job_board_mix WHERE order_line_id=$1) AS mix`, [outer.id]);
    if (outer.status === 'planned' || outer.sheets_required != null || outer.parent_sheets_required != null
        || +outer.fg_consumed_qty > 0 || +outer.dispatched_qty > 0
        || prior.pr || prior.hold || prior.mix) {
      // A savepoint, so a refusal can never leave half a rollback behind — today
      // rollbackLine refuses before its first write, but that is its business.
      await qc('SAVEPOINT carton_parts_convert');
      try {
        await rollbackLine({ lineId: outer.id, mode: 'rollback', note: 'carton now made in parts — each part carries its own board' }, qc, oc, user);
        await qc('RELEASE SAVEPOINT carton_parts_convert');
      } catch (e) {
        if (!e.blockers) throw e;
        await qc('ROLLBACK TO SAVEPOINT carton_parts_convert');
        out.warnings.push(`This line stays one carton this time — ${e.message}`);
        return out;
      }
      outer.status = 'pending';
    }
    await qc('UPDATE order_lines SET sheets_required=0, parent_sheets_required=0, wastage_sheets=0 WHERE id=$1',
      [outer.id]);
    await audit('order_line', outer.id, 'made_in_parts',
      'now made in parts — each part is planned and covered on its own board', qc, user);
  }

  const plan = partLineSyncPlan({ outer, parts, existing });
  // Qty and batch first — they do not depend on the list.
  for (const up of plan.update) {
    const was = existing.find(x => x.id === up.id);
    await qc('UPDATE order_lines SET qty=$1, line_remark=$2, part_label=$3, part_per_carton=$4 WHERE id=$5',
      [up.qty, up.line_remark, up.label, up.per_carton, up.id]);
    const batch = (was.line_remark ?? null) !== up.line_remark
      ? `, batch ${was.line_remark ?? 'none'} → ${up.line_remark ?? 'none'}` : '';
    await audit('order_line', up.id, 'part_line_updated',
      `${up.label} follows its carton — qty ${was.qty} → ${up.qty}${batch}`, qc, user);
    out.updated++;
  }
  // The LIST changes all-or-nothing on this carton line: removals first, then
  // inserts, then the un-made reset, under one savepoint. If one part cannot go
  // (its PR already on a purchase order, say), the whole list stays as it was
  // on this order with one warning — a half-applied list (an old part beside a
  // new one, or one lone part with the carton's board at zero) must never exist,
  // and one blocked line must never fail a whole parts save either.
  if (plan.remove.length || plan.insert.length) {
    const removeNote = `taken off carton line #${outer.id} in the Product Master`;
    await qc('SAVEPOINT carton_parts_list');
    try {
      for (const rm of plan.remove) {
        // The one way out for a part line (contract C8): its holds, PR and card go too.
        try {
          await rollbackLine({ lineId: rm.id, mode: 'delete', note: removeNote, viaCarton: true }, qc, oc, user);
        } catch (e) {
          if (e.blockers) e.message = `${existing.find(x => x.id === rm.id)?.label || 'A part'}: ${e.message}`;
          throw e;
        }
        out.removed++;
      }
      for (const ins of plan.insert) {
        // A part line remembers what it is — its label and pieces per carton —
        // so the order keeps deciding its carton even after the master changes.
        const [row] = await qc(
          `INSERT INTO order_lines (order_id, product_id, qty, rate, gst_pct, tolerance_pct, delivery_date,
                                    line_remark, part_of_line_id, part_label, part_per_carton)
           VALUES ($1,$2,$3,0,0,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [outer.order_id, ins.product_id, ins.qty, outer.tolerance_pct, outer.delivery_date || null,
           outer.line_remark ?? null, outer.id, ins.label, ins.per_carton]);
        await audit('order_line', row.id, 'part_line_created',
          `${ins.label} of carton line #${outer.id} — ${ins.qty}${outer.line_remark ? `, batch ${outer.line_remark}` : ''}`, qc, user);
        out.inserted++;
      }
      // Un-made: the master lists no parts any more and none is left on this
      // line — it is an ordinary carton again, planned on its own board from
      // scratch (its zeros would otherwise read as "needs no board" in Planning).
      if (!parts.length && out.removed === existing.length) {
        await qc('UPDATE order_lines SET sheets_required=NULL, parent_sheets_required=NULL, wastage_sheets=NULL WHERE id=$1', [outer.id]);
        await audit('order_line', outer.id, 'no_longer_in_parts', 'its parts were taken off the master — plan it as one carton', qc, user);
      }
      await qc('RELEASE SAVEPOINT carton_parts_list');
    } catch (e) {
      if (!e.blockers) throw e;
      await qc('ROLLBACK TO SAVEPOINT carton_parts_list');
      out.removed = 0;
      out.inserted = 0;
      out.warnings.push(`The parts list stays as it was on this order — ${e.message}`);
    }
  }
  out.warnings.push(...plan.warnings);
  return out;
}

// A part card has finished die cutting (contract C4): it is done — 'split', the
// state that already means "finished, not a finished-goods batch" — and its
// pieces are counted. No FG receipt: a part is not a saleable carton. The part
// line stays in_production until the carton's pasting card takes the pieces.
export async function closePartCard(jc, dieCutSheets, qc, oc, user = null) {
  const line = await oc('SELECT * FROM order_lines WHERE id=$1', [jc.order_line_id]);
  const master = await oc('SELECT * FROM products WHERE id=$1', [jc.product_id]);
  const pieces = partPieces({ dieCutSheets, ups: effectiveProduct(master, line).ups });
  const tot = await oc('SELECT COALESCE(SUM(qty_scrap),0)::int AS s FROM job_stages WHERE job_card_id=$1', [jc.id]);
  await qc(`UPDATE job_cards SET status='split', qty_produced=$1, qty_scrap=$2, closed_at=now() WHERE id=$3`,
    [pieces, tot.s, jc.id]);
  await audit('job_card', jc.id, 'part_die_cut',
    `${pieces} pieces die-cut — handed to the carton's pasting card`, qc, user);
  return pieces;
}

// Once EVERY part of the carton is die-cut, make its pasting card (contract C5).
// Returns the card id, or null while a part is still on the floor.
export async function maybeCreateAssemblyCard(outerLineId, qc, oc, user = null) {
  // Lock order: the order and the outer product BEFORE the carton — the order an
  // order edit (the order FOR UPDATE, then its lines) and a parts save (the
  // product, then its cartons) take them. Walking the carton's status below
  // writes it several times, and every write after the first re-checks its
  // foreign keys, share-locking the order and the product; asked for only then,
  // behind an edit that already holds the carton, that is a deadlock.
  const ref = await oc('SELECT order_id, product_id FROM order_lines WHERE id=$1', [outerLineId]);
  if (!ref) return null;
  await oc('SELECT id FROM orders WHERE id=$1 FOR KEY SHARE', [ref.order_id]);
  await oc('SELECT id FROM products WHERE id=$1 FOR KEY SHARE', [ref.product_id]);
  const outer = await oc('SELECT * FROM order_lines WHERE id=$1 FOR NO KEY UPDATE', [outerLineId]);
  if (!outer) return null;
  const existing = await oc('SELECT id FROM job_cards WHERE order_line_id=$1', [outer.id]);
  if (existing) return existing.id;

  // The carton's OWN part lines decide — never the live master, which may have
  // changed since these parts went to the floor (partsFrozen). Each line
  // remembers its label and pieces per carton; the master fills in only for a
  // line that predates that memory.
  const parts = await qc(`
    SELECT pl.id AS line_id, COALESCE(pl.part_label, pp.label, p.name) AS label,
           COALESCE(pl.part_per_carton, pp.per_carton, 1) AS per_carton,
           jc.jc_number, jc.status AS jc_status, jc.qty_produced
      FROM order_lines pl
      JOIN products p ON p.id = pl.product_id
      LEFT JOIN product_parts pp ON pp.outer_product_id = $2 AND pp.part_product_id = pl.product_id
      LEFT JOIN job_cards jc ON jc.order_line_id = pl.id
     WHERE pl.part_of_line_id = $1
     ORDER BY pp.seq NULLS LAST, pl.id`, [outer.id, outer.product_id]);
  // Every part card split? Read after the carton lock: two parts finishing at
  // once serialise on it, and under READ COMMITTED (the app's only isolation
  // level) the second sees the first's committed card — exactly one pasting
  // card, made by whichever part finishes last.
  if (!parts.length || parts.some(p => p.jc_status !== 'split')) return null;

  // 0 sets still makes the card: Sort & Paste closes it short, and the shortage
  // re-raise brings the carton (and its parts) back — the road any short job takes.
  const { sets, spare } = joinableSets(parts.map(p => ({ label: p.label, pieces: p.qty_produced, per_carton: p.per_carton })));
  const master = await oc('SELECT * FROM products WHERE id=$1', [outer.product_id]);
  let walk;
  try {
    walk = walkToInProduction(outer.status);
  } catch (e) {
    // The operator saving a die-cut never sees the carton line — name it.
    const po = await oc('SELECT po_number FROM orders WHERE id=$1', [outer.order_id]);
    e.message = `${master.code} on PO ${po?.po_number ?? outer.order_id}: ${e.message} — ask Planning`;
    throw e;
  }
  // Entering in_production puts the carton in board demand: pin its own need at
  // zero first, whatever its history, so it can never price its master board.
  await qc('UPDATE order_lines SET sheets_required=0, parent_sheets_required=0, wastage_sheets=0 WHERE id=$1', [outer.id]);
  for (const to of walk) await setLineStatus(outer.id, to, qc, oc, user);
  const product = effectiveProduct(master, outer);
  const jcNumber = await nextNumber('CI-JC-', 'job_cards', 'jc_number', oc);
  const [card] = await qc(
    `INSERT INTO job_cards (jc_number, order_line_id, product_id, qty_planned, sheets_issued, children_per_parent, is_assembly)
     VALUES ($1,$2,$3,$4,$4,1,true) RETURNING id`,
    [jcNumber, outer.id, outer.product_id, sets]);
  const stages = assemblyStages(routingFor(product));
  for (let i = 0; i < stages.length; i++) {
    await qc('INSERT INTO job_stages (job_card_id, seq, stage, unit) VALUES ($1,$2,$3,$4)',
      [card.id, i + 1, stages[i].stage, stages[i].unit]);
  }
  // The parts' work is done: their pieces now live on the pasting card. Walking
  // them to a terminal status keeps order completion, pendency and dispatch from
  // ever waiting on a line no customer ordered.
  for (const p of [...parts].sort((a, b) => a.line_id - b.line_id)) {   // ascending id, like every multi-line lock
    await setLineStatus(p.line_id, 'produced', qc, oc, user);
    await setLineStatus(p.line_id, 'dispatched', qc, oc, user);
    await audit('order_line', p.line_id, 'part_pasted', `${p.label} handed to pasting card ${jcNumber}`, qc, user);
  }
  const joined = parts.map(p => `${p.label} ${p.jc_number} (${p.qty_produced})`).join(' + ');
  const left = spare.length ? ` — spare ${spare.map(s => `${s.label} ${s.qty}`).join(', ')}` : '';
  await audit('job_card', card.id, 'create_assembly', `${jcNumber} pastes ${joined} → ${sets} cartons${left}`, qc, user);
  return card.id;
}
```

- [ ] **Step 4: Confirm they pass.**
  - Check the exports: `grep -n "^export \(async \)\?function \(audit\|effectiveProduct\|nextNumber\|releasePlanLockHolds\|routingFor\|setLineStatus\)\b" server/src/helpers.js` must list all six.
  - Run: `cd server && node --test src/carton-parts-pins.test.js`
  - Expected: PASS.

- [ ] **Step 5: Do not commit.**

---

### Task 5: Floor wiring in `production.js`

**Files:**
- Modify: `server/src/routes/production.js`. Anchors:
  - `judgeParentSheets` at 615
  - start-route branch at 1286
  - `/job-stages/:id/complete` close block at ~2976
  - `GET /job-cards/:id` at 586

- [ ] **Step 1: Add the failing pins**

```js
test('production.js: parts join at die cut, the pasting card never draws board', () => {
  const prod = src('./routes/production.js');
  assert.match(prod, /import \{ closePartCard, maybeCreateAssemblyCard \} from '\.\.\/carton-parts-db\.js'/);
  // the join branch sits between the gang split and the ordinary close
  assert.match(prod, /splitGangParentJob\(jc\.id[\s\S]{0,400}shouldJoinAtDieCut\([\s\S]{0,400}closePartCard\(jc, qty_out[\s\S]{0,200}maybeCreateAssemblyCard\(partOf[\s\S]{0,200}else if \(st\.seq === last\.mx\)/);
  assert.match(prod, /if \(!prev && \(jc\.parent_job_card_id \|\| jc\.is_assembly\)\)/);
  assert.match(prod, /if \(jc\.parent_job_card_id \|\| jc\.is_assembly \|\| \(!jc\.order_line_id && !jc\.gang_run_id\)\) return null;/);
  assert.match(prod, /await attachCartonParts\(jc\)/);
  assert.match(prod, /NOT jc\.is_assembly AND/);
  assert.match(src('./routes/floor.js'), /NOT jc\.is_assembly AND/);
  // the printed bands read the order's own part lines, never an inner join on the master
  assert.match(prod, /FROM order_lines x WHERE x\.part_of_line_id = pl\.part_of_line_id\) AS of_parts/);
  assert.doesNotMatch(prod, /\n\s*JOIN product_parts pp/);
});
```

- [ ] **Step 2: Confirm it fails.**
  - Run: `cd server && node --test src/carton-parts-pins.test.js`
  - Expected: FAIL on the new test.

- [ ] **Step 3: Implement**

(a) Imports at the top:
```js
import { closePartCard, maybeCreateAssemblyCard } from '../carton-parts-db.js';
import { shouldJoinAtDieCut } from '../carton-parts.js';
```

(b) In `judgeParentSheets`, change the first line:
```js
  if (jc.parent_job_card_id || jc.is_assembly || (!jc.order_line_id && !jc.gang_run_id)) return null;
```
Extend its comment: a pasting card counts cartons in `sheets_issued`, like a split child.

(c) In the start route (1286), change the condition and add one comment line:
```js
      if (!prev && (jc.parent_job_card_id || jc.is_assembly)) {
        // … existing comment … A carton's PASTING CARD is the same shape: its
        // pieces were cut, printed and die-cut on the part cards.
```

(d) In `/job-stages/:id/complete`:
- Directly after `const runKind = …;`, add:
```js
      // A PART of a carton made in parts ends here (carton-parts.js).
      const partOf = jc.order_line_id
        ? (await oc('SELECT part_of_line_id FROM order_lines WHERE id=$1', [jc.order_line_id]))?.part_of_line_id
        : null;
```
- Then insert a middle branch so the chain reads:
```js
      if (shouldSplitAtDieCut({ … unchanged … })) {
        await splitGangParentJob(jc.id, qc, oc, req.user.name);
      } else if (shouldJoinAtDieCut({ isLastStage: st.seq === last.mx, stage: st.stage, partOfLineId: partOf })) {
        await closePartCard(jc, qty_out, qc, oc, req.user.name);
        await maybeCreateAssemblyCard(partOf, qc, oc, req.user.name);
      } else if (st.seq === last.mx) {
```
- Confirm `qty_out` is the variable this handler already passes to `fgReceipt` in the ordinary close. It is the completed stage's good count, written at line 2551.

(e) Add next to `attachTools`:
```js
// The carton-in-parts facts a job card prints (JobCardPartsBand), read from the
// ORDER's own part lines (carton-parts.js contract C9) — the master only lends
// each part its label while it still lists it. A part card names its carton and
// how many parts it has; a pasting card names the part cards it joins.
async function attachCartonParts(jc) {
  if (jc.is_assembly) {
    jc.carton_parts = { role: 'assembly', parts: await q(`
      SELECT COALESCE(pl.part_label, pp.label, p.name) AS label, pj.jc_number, pj.qty_produced
        FROM order_lines pl
        JOIN order_lines ol ON ol.id = pl.part_of_line_id
        JOIN products p ON p.id = pl.product_id
        LEFT JOIN product_parts pp ON pp.outer_product_id = ol.product_id AND pp.part_product_id = pl.product_id
        LEFT JOIN job_cards pj ON pj.order_line_id = pl.id
       WHERE pl.part_of_line_id = $1
       ORDER BY pp.seq NULLS LAST, pl.id`, [jc.order_line_id]) };
    return;
  }
  const me = jc.order_line_id && await one(`
    SELECT pl.part_of_line_id, COALESCE(pl.part_label, pp.label, p.name) AS label,
           op.code AS outer_code, op.name AS outer_name,
           (SELECT COUNT(*)::int FROM order_lines x WHERE x.part_of_line_id = pl.part_of_line_id) AS of_parts
      FROM order_lines pl
      JOIN order_lines ol ON ol.id = pl.part_of_line_id
      JOIN products p ON p.id = pl.product_id
      JOIN products op ON op.id = ol.product_id
      LEFT JOIN product_parts pp ON pp.outer_product_id = ol.product_id AND pp.part_product_id = pl.product_id
     WHERE pl.id = $1`, [jc.order_line_id]);
  if (me?.part_of_line_id) jc.carton_parts = { role: 'part', ...me };
}
```
Call `await attachCartonParts(jc);` in `GET /job-cards/:id` after `await attachTools(jc);` (601). Check that `q` and `one` are already imported in production.js; they are used throughout.

(f) **A finished part's die-cut count cannot be adjusted** (`POST /job-stages/:id/adjust`, ~3632). Adjusting it would leave the part's pieces and the pasting card's size stale. Once the route has the stage's job card, refuse when that card is a finished part: status `'split'` and its line has `part_of_line_id`. Reuse `splitGangReverseBlock`'s finished-part wording: build the card row with `part_of_line_id` (a `LEFT JOIN order_lines` on the card's line) and pass it to `splitGangReverseBlock`. Throw a 409 with its message. Read the route first; it already refuses some cases. Put this refusal beside them.

(h) **The floor board agrees** (`server/src/routes/floor.js` ~462, `GET /floor`). Its own `board_pending` expression has no pasting-card clause, so Sort & Paste would read "BOARD PENDING" on every pasting card. Prefix that expression with `NOT jc.is_assembly AND`, the same as JC_VIEW. (A split gang child raises the same false flag there today; that predates this feature and stays out of scope.) Pin: `assert.match(src('./routes/floor.js'), /NOT jc\.is_assembly AND/);` in the Task 5 pin test.

(i) **The pasting card and part cards reach older routes; each must know them** (from the Task 5 review; every case reproduced on Postgres):
- **Amend** (`POST /job-cards/:id/amend`, ~907, auto-follow ~942). Refuse `order_qty` on a pasting card (`jc.is_assembly`) or a part card (its line has `part_of_line_id`), with "change the carton in Orders → Edit". Never auto-follow `sheets_issued` for an `is_assembly` card. Otherwise the carton's 0 sheets are re-derived from the outer's own board (contract C2), and the pasting card gets board sheets in a cartons column.
- **Artwork gate.** The pasting card's floor light reads red "Artwork not locked" and finalise refuses, because the carton line is never artwork-locked. Every part line had to be artwork-locked to get its card, so `maybeCreateAssemblyCard` sets `artwork_customer_ok=1, artwork_qa_ok=1, artwork_locked=1` on the carton in the same UPDATE that zeroes its sheets.
- **Send back / pull back** must treat a pasting card like the split child it mirrors, not as the start of a route:
  - add `jc.is_assembly` to `REVERSE_STAGE_COLS`;
  - set `child = isSplitChild(m) || m.is_assembly` in the reverse plan (helpers.js ~4441/4461);
  - `isFirstStage` is false for an `is_assembly` card;
  - `pullBackToJobCard` (~5127) refuses an `is_assembly` card as it refuses a child.
- **Adjust preview.** Move the finished-part refusal into `stageImpact` (~3573) as `out.blocked`, so `GET /job-stages/:id/impact` and the POST (which throws `impact.blocked`) agree. Remove the now-duplicate guard in the POST route.
- **Live job-card register.** The live scope (~522) keeps `split` cards for gang runs. Exclude `status='split' AND gang_run_id IS NULL` (finished part cards) from the live load and from `JOB_CARD_PICKER_SQL` (~612), and count them with the closed cards.
- **Operator messages.**
  - Add `ol.part_of_line_id` to JC_VIEW (`ol` is already joined).
  - In `client/src/pages/Production.jsx`, a part card's last stage (~1055) reads "Final stage for this part — its pieces go to the carton's pasting card".
  - The completion toast (~566) reads "Part die-cut — pieces handed to the carton's pasting card", never "FG added".
- **The `partOf` lookup** in `/complete` runs only when `st.seq === last.mx && st.stage === 'die_cutting'`.
- **Pins:** the adjust refusal (in `stageImpact`), `CASE WHEN jc.is_assembly THEN 0` in `board_short_sheets`, the amend refusal, the carton artwork flags, `child = isSplitChild(m) || m.is_assembly`, and the live-scope exclusion.

(g) **A pasting card draws no board.** In `JC_VIEW`, `board_pending` compares the outer's board stock with `jc.sheets_issued`, which on a pasting card holds CARTONS. It must read false for `jc.is_assembly`: prefix its expression with `NOT jc.is_assembly AND`. Also check how a split gang child (`jc.parent_job_card_id` set; its `sheets_issued` also holds cartons) avoids this today, and mirror that if it does it differently. `board_short_sheets` likewise reads 0 for a pasting card.

- [ ] **Step 4: Confirm it passes.**
  - Run: `cd server && node --test src/carton-parts-pins.test.js` → PASS.
  - Then the full suite. Expected: 0 new failures.

- [ ] **Step 5: Do not commit.**

---

### Task 6: Product Master "Made in parts"

**Files:**
- Create: `server/src/routes/product-parts.js`
- Modify: `server/src/app.js`, `server/src/routes/masters.js` (`/products/picker`), `server/src/products-picker.test.js` (it pins the picker's columns)
- Create: `client/src/components/ProductPartsEditor.jsx`
- Modify: `client/src/components/ProductMasterEditor.jsx`

- [ ] **Step 1: Add the failing pins**

```js
test('parts route is mounted, validates through partsSetError and re-syncs open lines', () => {
  const route = src('./routes/product-parts.js');
  assert.match(src('./app.js'), /app\.use\('\/api', productParts\)/);
  assert.match(route, /r\.get\('\/products\/:id\/parts'/);
  assert.match(route, /r\.put\('\/products\/:id\/parts', canEdit/);
  assert.match(route, /partsSetError\(/);
  assert.match(route, /pg_advisory_xact_lock\(hashtext\('product_parts'\)\)/);
  assert.match(route, /FROM products WHERE id=\$1 FOR KEY SHARE/);
  assert.match(route, /syncPartLines\(l\.id, qc, oc, req\.user\.name\)/);
  assert.match(src('./routes/masters.js'), /EXISTS \(SELECT 1 FROM product_parts pp WHERE pp\.part_product_id = p\.id\) AS is_part/);
});
```

- [ ] **Step 2: Confirm it fails.**
  - Run: `cd server && node --test src/carton-parts-pins.test.js`
  - Expected: FAIL.

- [ ] **Step 3: Implement the route** `server/src/routes/product-parts.js`:

```js
// "Made in parts" on the Product Master — the list of parts an outer carton is
// printed as (carton-parts.js). Saving it re-syncs every open order line of the
// carton, so a PO already booked before the parts were set up converts itself.
import { Router } from 'express';
import { q, one, tx } from '../db.js';
import { audit } from '../helpers.js';
import { requireRole } from '../auth.js';
import { partsSetError } from '../carton-parts.js';
import { syncPartLines } from '../carton-parts-db.js';

const r = Router();
const canEdit = requireRole('planner'); // admin implied — same as masters.js

const PARTS_OF = `
  SELECT pp.id, pp.part_product_id, pp.label, pp.per_carton, pp.seq,
         p.code, p.name, p.board_name, p.gsm, p.child_l, p.child_w, p.ups, p.die_number
    FROM product_parts pp JOIN products p ON p.id = pp.part_product_id
   WHERE pp.outer_product_id = $1 ORDER BY pp.seq, pp.id`;

r.get('/products/:id/parts', async (req, res, next) => {
  try {
    const id = +req.params.id;
    const partOf = await q(`
      SELECT op.id, op.code, op.name FROM product_parts pp JOIN products op ON op.id = pp.outer_product_id
       WHERE pp.part_product_id = $1 ORDER BY op.code`, [id]);
    res.json({ parts: await q(PARTS_OF, [id]), part_of: partOf });
  } catch (e) { next(e); }
});

r.put('/products/:id/parts', canEdit, async (req, res, next) => {
  try {
    const outerId = +req.params.id;
    const parts = (Array.isArray(req.body.parts) ? req.body.parts : []).map((p, i) => ({
      part_product_id: Number(p.part_product_id), label: String(p.label || '').trim(),
      per_carton: Number(p.per_carton ?? 1), seq: i + 1,
    }));
    const result = await tx(async (qc, oc) => {
      // One writer at a time for EVERY parts list: the one-level rule reads other
      // cartons' lists, so two saves at once (X gets part P while P gets parts of
      // its own) could each pass it. Tiny table, rare writes — a global lock is fine.
      await qc(`SELECT pg_advisory_xact_lock(hashtext('product_parts'))`);
      // KEY SHARE: enough to stop the product being deleted or moved to another
      // customer mid-save; anything stronger deadlocks against plan-save and
      // artwork approval, which lock a line and then update this product row.
      const outer = await oc('SELECT id, customer_id, code FROM products WHERE id=$1 FOR KEY SHARE', [outerId]);
      if (!outer) throw Object.assign(new Error('Product not found'), { status: 404 });
      const ids = parts.map(p => p.part_product_id);
      const products = new Map((ids.length
        ? await qc('SELECT id, customer_id FROM products WHERE id = ANY($1::int[])', [ids]) : [])
        .map(p => [p.id, p]));
      const outerIsPart = !!(await oc('SELECT 1 AS x FROM product_parts WHERE part_product_id=$1 LIMIT 1', [outerId]));
      const partsWithParts = ids.length
        ? (await qc('SELECT DISTINCT outer_product_id AS id FROM product_parts WHERE outer_product_id = ANY($1::int[])', [ids])).map(x => x.id)
        : [];
      const err = partsSetError({ outer, parts, products, outerIsPart, partsWithParts });
      if (err) throw Object.assign(new Error(err), { status: 400 });

      await qc('DELETE FROM product_parts WHERE outer_product_id=$1', [outerId]);
      for (const p of parts) {
        await qc(`INSERT INTO product_parts (outer_product_id, part_product_id, label, per_carton, seq, created_by)
                  VALUES ($1,$2,$3,$4,$5,$6)`,
          [outerId, p.part_product_id, p.label, p.per_carton, p.seq, req.user.name]);
      }
      await audit('product', outerId, 'parts_saved',
        parts.length ? parts.map(p => `${p.label} ×${p.per_carton}`).join(' + ') : 'no longer made in parts', qc, req.user.name);

      // Every open line of this carton follows — including lines booked before
      // the parts existed (the PO 02545 shape).
      const warnings = [];
      let synced = 0;
      const lines = await qc(`SELECT id FROM order_lines WHERE product_id=$1 AND part_of_line_id IS NULL
                               AND status IN ('pending','planned') ORDER BY id`, [outerId]);
      for (const l of lines) {
        const s = await syncPartLines(l.id, qc, oc, req.user.name);
        synced += s.inserted + s.updated + s.removed;
        warnings.push(...s.warnings.map(w => `line ${l.id}: ${w}`));
      }
      return { synced, warnings };
    });
    res.json({ parts: await q(PARTS_OF, [outerId]), ...result });
  } catch (e) { next(e); }
});

export default r;
```

Mount it in `app.js`, next to `fluence`:
```js
import productParts from './routes/product-parts.js';
…
app.use('/api', productParts);
```
Mount it before the masters loop's `/products/:id` routes, if order matters there. Check the `app.use` order; `masters` is mounted earlier and its routes are `/products/:id` with GET/PUT. **They do not clash**, because `/products/:id/parts` has an extra segment.

(b) `/products/picker` in `masters.js`: add a select column:
```sql
             p.output_number, p.size,
             EXISTS (SELECT 1 FROM product_parts pp WHERE pp.part_product_id = p.id) AS is_part
```
Update `products-picker.test.js`: add `is_part` to the pinned column list. Do not relax anything else it asserts.

(c) Client `client/src/components/ProductPartsEditor.jsx`:

```jsx
import { useEffect, useState } from 'react';
import { api } from '../api.js';

// "Made in parts" — the pieces this carton is printed as. Each part is its own
// Product Master row (its own board, size, ups, die, plate). The PO only ever
// names the carton; Planning covers each part on its own board.
export default function ProductPartsEditor({ product, customerProducts = [] }) {
  const [rows, setRows] = useState([]);
  const [partOf, setPartOf] = useState([]);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!product?.id) return;
    api.get(`/products/${product.id}/parts`).then(d => {
      setRows(d.parts.map(p => ({ part_product_id: String(p.part_product_id), label: p.label, per_carton: p.per_carton })));
      setPartOf(d.part_of);
    });
  }, [product?.id]);

  if (!product?.id) return null;
  if (partOf.length) {
    return <p className="text-sm text-slate-500">This is a part of {partOf.map(o => o.code).join(', ')} — a part cannot have parts.</p>;
  }
  const choices = customerProducts.filter(p => p.id !== product.id);
  const set = (i, patch) => setRows(rs => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const save = () => {
    setBusy(true); setMsg(null);
    return api.put(`/products/${product.id}/parts`, {
      parts: rows.filter(r => r.part_product_id).map(r => ({ ...r, part_product_id: +r.part_product_id, per_carton: +r.per_carton || 1 })),
    }).then(d => setMsg(d.warnings?.length ? d.warnings.join(' · ') : `Saved — ${d.parts.length ? `${d.parts.length} parts` : 'not made in parts'}${d.synced ? `, ${d.synced} open line changes` : ''}`))
      .catch(e => setMsg(e.message)).finally(() => setBusy(false));
  };

  return (
    <section className="mt-6 rounded-xl border border-slate-200 p-4">
      <h3 className="text-sm font-semibold text-slate-800">Made in parts</h3>
      <p className="mt-0.5 text-xs text-slate-500">
        Printed as separate pieces on separate sheets and pasted into one carton. Leave empty for a normal carton.
      </p>
      {rows.map((r, i) => (
        <div key={i} className="mt-2 grid grid-cols-[1fr_120px_90px_32px] items-center gap-2">
          <select className="input" value={r.part_product_id} onChange={e => set(i, { part_product_id: e.target.value })}>
            <option value="">Pick the part's product…</option>
            {choices.map(p => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}
          </select>
          <input className="input" value={r.label} placeholder={`Part ${i + 1}`} onChange={e => set(i, { label: e.target.value })} />
          <input className="input" type="number" min="1" value={r.per_carton} title="Pieces per carton"
            onChange={e => set(i, { per_carton: e.target.value })} />
          <button type="button" className="text-slate-400 hover:text-red-600" onClick={() => setRows(rs => rs.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <div className="mt-3 flex items-center gap-3">
        <button type="button" className="btn" onClick={() => setRows(rs => [...rs, { part_product_id: '', label: `Part ${rs.length + 1}`, per_carton: 1 }])}>Add part</button>
        <button type="button" className="btn-brand" disabled={busy} onClick={save}>Save parts</button>
        {msg && <span className="text-xs text-slate-600">{msg}</span>}
      </div>
    </section>
  );
}
```

Before writing it, open `ProductMasterEditor.jsx` and `Masters.jsx`:
- Use the existing `api` import path and the input/button class names they use. Replace `input` / `btn` / `btn-brand` above with whatever those files use (memory: `.btn-brand` swallows `bg-*`, so do not add a `bg-` class to it).
- Render `<ProductPartsEditor product={product} customerProducts={…} />` at the end of the editor body, for an **existing** product only (`product?.id`).
- `customerProducts` comes from the `/products/picker` list the page already loads, filtered to `p.customer_id === product.customer_id`. If the editor has no such list, fetch `/products/picker` once in the editor.

**As built (review-approved deviations, recorded here):**
- **Route: order lock first.** Before syncing each open line, the route takes that line's ORDER `FOR KEY SHARE`, because order edits lock the order and then its lines. Without it, a save racing an order edit deadlocked (reproduced).
- **Route: stricter input.** A missing or bad product id gives a 400 naming the row. A body without a `parts` array is refused rather than read as "clear".
- **Route: unchanged lists.** An unchanged list rewrites nothing but still re-syncs.
- **Route: history and warnings.** The history line names each part's code, and warnings lead with the PO number.
- **Picker test.** Its "no WHERE" assertion now allows exactly the `is_part` EXISTS column, and still fails on any top-level or joined WHERE.
- **Both edit dialogs.** The editor renders in BOTH product edit dialogs: `ProductMasterEditor.jsx` (Product 360) and the Masters → Products edit dialog in `client/src/pages/Masters.jsx`.

**Review fixes (Task 6 code review, reproduced on Postgres):**
- **Product lock.** Lock the outer product `FOR KEY SHARE`, not `FOR NO KEY UPDATE`. Plan-save, artwork approval and the gang master write lock a line first and then UPDATE the product row, so NO KEY UPDATE deadlocked (40P01). KEY SHARE still blocks a delete and a customer move (a key update, since `code` is UNIQUE).
- **C1 at the other doors.** The product PUT's customer change and `/products/:id/migrate-customer` (masters.js ~282 and ~452; also PO-import "Move & use") refuse with a 409 when the product has parts or is a part: "…is made in parts (or is a part of SW-715) — clear its parts list first". The check runs under the product row lock.
- **Pins:** the order `FOR KEY SHARE` directly before `syncPartLines(l.id, …)`; the product `FOR KEY SHARE`; the two masters.js refusals.
- **Stale editor.** `key={product.id}` on the editor in both dialogs, so a product switch never shows the old list.
- **Warnings survive a close.** They also go to the page's toast, so closing the dialog mid-save doesn't lose them.
- **Warnings identify the line:** PO number plus qty and batch, since PO 02545 carries SW-715 twice.
- **Pieces-per-carton cap:** `partsSetError` refuses above 1000 with a message naming the row. There is a unit test.
- **Phones:** the pieces box shows "pcs".
- **Lock order:** open lines are locked `ORDER BY ol.order_id, ol.id`.
- **Board on each row:** each chosen part row shows its board and ups, so a part with no board on file is visible at setup.

- [ ] **Step 4: Confirm it passes.**
  - Run: `cd server && node --test src/carton-parts-pins.test.js src/products-picker.test.js`
  - Expected: PASS.
  - `cd client && npm run build`: builds.

- [ ] **Step 5: Do not commit.**

---

### Task 7: Order entry and order edit

**Files:**
- Modify: `server/src/routes/orders.js`:
  - POST `/orders` at 247
  - PUT `/orders/:id` at 288; its `existing` query at 300, delete loop at 347
  - `/order-lines/:id/cancel` at ~389
  - `DELETE /orders/:id` at 533; its line loop at ~569
- Modify: `server/src/routes/dispatch.js` (shortage insert at 633)
- Modify: `client/src/pages/Orders.jsx` (edit seed at 465; PO product pickers)

- [ ] **Step 1: Add the failing pins**

```js
test('every door that makes, edits, cancels or deletes a carton line handles its parts', () => {
  const orders = src('./routes/orders.js');
  const dispatch = src('./routes/dispatch.js');
  assert.match(orders, /import \{ syncPartLines \} from '\.\.\/carton-parts-db\.js'/);
  assert.match(orders, /INSERT INTO order_lines \(order_id, product_id, qty, rate, gst_pct, tolerance_pct, line_remark\) VALUES \(\$1,\$2,\$3,\$4,\$5,\$6,\$7\) RETURNING id',\s*\n\s*\[o\.id/);
  assert.equal((orders.match(/syncPartLines\(/g) || []).length >= 3, true);  // import + POST + PUT
  assert.match(orders, /SELECT \* FROM order_lines WHERE order_id=\$1 AND part_of_line_id IS NULL ORDER BY id/);
  assert.match(orders, /rollbackLine\(\{ lineId: line\.id, mode: 'delete'/);                        // edit removes a carton
  assert.match(orders, /\+product\.id !== \+current\.product_id && \(await partLinesOf\(current\.id, qc\)\)\.length/); // a carton never changes product
  assert.match(orders, /for \(const p of partLines\) await setLineStatus\(p\.id, 'cancelled'/);          // cancel a carton
  assert.match(orders, /for \(const l of lines\.filter\(x => !x\.part_of_line_id\)\)/);                   // delete an order
  assert.match(dispatch, /syncPartLines\(newLine\.id, qc, oc, user\)/);
  assert.match(src('../../client/src/pages/Orders.jsx'), /o\.lines\.filter\(l => !l\.part_of_line_id\)\.map\(/);
});
```

- [ ] **Step 2: Confirm it fails.**
  - Run: `cd server && node --test src/carton-parts-pins.test.js`
  - Expected: FAIL.

- [ ] **Step 3: Implement**

(a) `orders.js` imports:
```js
import { syncPartLines } from '../carton-parts-db.js';
import { partsChangeBlock } from '../carton-parts.js';
```
Add `partLinesOf` to the existing `../helpers.js` import.

(a2) **Serialise order entry with a parts-list save.** A PO booked at the same instant a carton's parts are saved must not slip through unconverted. As the FIRST statement inside the transaction of POST `/orders`, PUT `/orders/:id` and the dispatch shortage re-raise, before any row lock, add:
```js
      // A carton's parts list saved at this same instant must not miss this line
      // (carton-parts.js): the parts save holds this lock exclusively. Taken
      // FIRST, before the order row — taken later it deadlocks against the
      // save, which locks each order after this lock.
      await qc(`SELECT pg_advisory_xact_lock_shared(hashtext('product_parts'))`);
```
Pin: `/pg_advisory_xact_lock_shared\(hashtext\('product_parts'\)\)/` in orders.js (twice) and dispatch.js.

(b) **POST `/orders`.** Make the line insert `RETURNING id` (keep the column list byte-identical) and sync each line inside the tx:
```js
        const [made] = await qc('INSERT INTO order_lines (order_id, product_id, qty, rate, gst_pct, tolerance_pct, line_remark) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
          [o.id, l.product_id, l.qty, l.rate ?? prod?.rate ?? 0, resolveGst(l.gst, prod || {}), tol, cleanLineRemark(l.line_remark)]);
        // A carton made in parts gets its hidden part lines now (carton-parts.js).
        await syncPartLines(made.id, qc, oc, req.user.name);
```

(c) **PUT `/orders/:id`.**
- `existing` becomes `'SELECT * FROM order_lines WHERE order_id=$1 AND part_of_line_id IS NULL ORDER BY id'`. Part lines are never in the payload, and the delete loop must never see them.
- In the delete loop, directly after `if (keepIds.includes(line.id)) continue;`:
```js
        // A carton made in parts leaves through rollbackLine, which takes each of
        // its parts with it — holds, PRs and cards undone the one audited way,
        // under each part's own blockers (carton-parts.js contract C8).
        if ((await partLinesOf(line.id, qc)).length) {
          await rollbackLine({ lineId: line.id, mode: 'delete', note: `removed in an edit of order ${po_number}` }, qc, oc, req.user.name);
          continue;
        }
```
  `rollbackLine` is already imported in this file.
- In the `if (l.id)` branch, directly before the `UPDATE order_lines SET product_id=$1, …` statement:
```js
          // A carton made in parts never turns into another product in an edit:
          // its parts (and their board) belong to this product, and a blocked
          // removal would leave the old parts under the new product. Remove the
          // line (rollbackLine stops at each part's blockers) and add the new one.
          if (+product.id !== +current.product_id && (await partLinesOf(current.id, qc)).length) {
            throw Object.assign(new Error(`Line ${current.id}: this carton is made in parts — remove the line and add the new product instead`), { status: 409 });
          }
```
- After the delete loop, before the order audit:
```js
      // Qty / batch / product changes follow onto each carton's part lines.
      for (const id of keepIds) {
        const s = await syncPartLines(id, qc, oc, req.user.name);
        warnings.push(...s.warnings);
      }
```

(d) **`/order-lines/:id/cancel`.** Replace the route body. Today it is a single `setLineStatus` inside `tx`:
```js
r.post('/order-lines/:id/cancel', canPlan, async (req, res, next) => {
  try {
    res.json(await tx(async (qc, oc) => {
      const lineId = +req.params.id;
      const line = await oc('SELECT * FROM order_lines WHERE id=$1', [lineId]);
      // A carton made in parts cancels with its parts; a part never alone
      // (carton-parts.js). setLineStatus releases a planned part's holds.
      const partLines = line ? await partLinesOf(line.id, qc) : [];
      const partBlock = line && partsChangeBlock(line, partLines);
      if (partBlock) throw Object.assign(new Error(partBlock), { status: 409 });
      const out = await setLineStatus(lineId, 'cancelled', qc, oc, req.user.name);
      for (const p of partLines) await setLineStatus(p.id, 'cancelled', qc, oc, req.user.name);
      return out;
    }));
  } catch (e) { next(e); }
});
```
Keep the existing comment block above the route. The guard allows only `pending` / `planned` parts, and both may move to `cancelled`. A missing line still reaches `setLineStatus`, which returns its own 404.

(d2) **`DELETE /orders/:id`.** A carton takes its parts through `rollbackLine`, so the loop must never reach a part itself; it would already be gone. Change the lines query and the loop:
```js
      const lines = await qc('SELECT id, gang_run_id, part_of_line_id FROM order_lines WHERE order_id=$1 ORDER BY id FOR UPDATE', [orderId]);
      …
      // A carton made in parts takes its parts with it (rollbackLine, contract C8).
      for (const l of lines.filter(x => !x.part_of_line_id)) {
```
`scopeLineIds` stays the set of ALL the order's line ids. In the closing audit, count the removed lines as `lines.filter(x => !x.part_of_line_id).length`.

In `deletePreview` (~446), add `ol.part_of_line_id` to its `lines` SELECT. Change the "with N item(s)" text to count `lines.filter(l => !l.part_of_line_id).length`. Keep every other use of `lines` / `lineIds` there unchanged; the preview still looks at the parts' cards and blockers.

(e) **`dispatch.js` shortage re-raise.** Import `syncPartLines` from `../carton-parts-db.js`. After the `newLine` insert, add:
```js
      // A carton made in parts re-raises its parts with it (carton-parts.js).
      await syncPartLines(newLine.id, qc, oc, user);
```

(f) **`Orders.jsx`.**
- At 465: `lines: o.lines.filter(l => !l.part_of_line_id).map(l => ({`.
- Find every product `<select>` / picker fed by `/products/picker` in this page (`grep -n "picker" client/src/pages/Orders.jsx`) and drop parts from its options: `.filter(p => !p.is_part)`.
- In the read-only order detail table, if it lists `order.lines`:
  - render each part line (`l.part_of_line_id` set) right under its carton row;
  - indent its product cell and prefix it with `↳ {l.part_label}`;
  - render a part line's status `dispatched` as **Pasted**.
  
  If the detail view has no line table, skip this; Planning and pendency carry the parts.

(g) **The PO import recognises parts, and warns about the PO 02545 shape.** The PO team's main door.
- **Picker lists.** `GET /products` gains `is_part` and `has_parts`. The Orders pickers and the Import PO wizard's product list leave parts out; an edit line keeps its own current product.
- **The matcher** (`server/src/routes/import.js` `matchAll`). A PO row whose best hit is a PART is NOT auto-matched and NOT silently re-matched to the nearest carton. It returns as `suggested`, with its carton(s) as the suggestions and a `part_note` like "Part 1 of SW-715 — a carton made in parts is ordered once, as the carton". Parts stay OUT of the sister-customer ("Move here & use") candidates.
- **The wizard.** It shows `part_note` on the row and drops any part match as belt and braces. When a carton made in parts (`has_parts`) is picked on more than one row of the same PO, those rows show a soft amber warning: "SW-715 is made in parts and is on 2 rows of this PO — order it once unless the customer really ordered it twice". Warn, never refuse.

(h) **Review fixes (Task 7 code review, probe-verified):**
- **Import rate.** On a row with a `part_note`, picking the carton seeds the carton's MASTER rate, never the part's PDF price (`toFormLine` and `pickProduct`). A read-only chip reads "PDF ₹7 is Part 1's price — SW-715 master ₹12.5 used", with no update-master button.
- **Carton removal audit.** Removing a carton in an order edit writes the `removedLineDetail(line, product)` text (product · qty · was status) as its note, like a plain line.
- **Double-carton warning everywhere a PO is typed:**
  - POST and PUT `/orders` return a warning when a product with parts appears on more than one non-cancelled line of the order.
  - The new-order and edit forms show the same amber note, using `has_parts`.
  - It warns only, never refuses.
- **Cancel race.** Cancel locks the carton's part lines `FOR NO KEY UPDATE` in id order before reading their statuses.
- **Stale tabs.** PUT skips payload lines that are this order's own part lines, instead of 404.
- **Part as a standalone line.** POST/PUT warn (never refuse) when a line's product is a part: "SW-770 is a part of SW-715 — order the carton".
- **Import edges:**
  - `pickProduct` clears `part_note` when the pick is not one of the suggested cartons;
  - candidate lookups prefer non-parts (parts ordered last);
  - the sister list also excludes cartons made in parts (a move would 409);
  - the "+" create-master button is hidden on part rows;
  - the duplicate count ignores rows with no qty.
- **Messages name the carton:**
  - removing a busy carton: "SW-715: Part 1: Printing is in progress…";
  - the product-change refusal names the product, not a line id;
  - Close Order / status → cancelled with a part on the floor gives `partsChangeBlock`'s message prefixed with the carton code, not "Invalid status change".

- [ ] **Step 4: Confirm it passes.**
  - Run: `cd server && node --test src/carton-parts-pins.test.js` → PASS.
  - Full suite: 0 new failures.
  - `cd client && npm run build` → builds.

- [ ] **Step 5: Do not commit.**

---

### Task 8: Planning: hide the carton, show each part on its own board

**Files:**
- Modify: `server/src/routes/orders.js`:
  - `LINE_VIEW` at 69–201; append the fields before `gg.gang_number` and the joins after `LEFT JOIN tools dc …`
  - `GET /planning` at 1360
- Modify: `server/src/routes/gangs.js` (`MEMBER_VIEW` at 35; members guards at 988, 1092, 2584)
- Create: `client/src/lib/cartonParts.js`, `client/src/components/PartChip.jsx`
- Modify: `client/src/pages/Planning.jsx` (Product cell at 3831–3834)

- [ ] **Step 1: Add the failing tests.** Put the `import` line at the **top** of `carton-parts-pins.test.js` with the other imports; append the tests.

```js
import { partChipText, cartonBoardSummary } from '../../client/src/lib/cartonParts.js';

test('planning: carton hidden, parts adjacent, part fields on LINE_VIEW', () => {
  const orders = src('./routes/orders.js');
  assert.match(orders, /pp\.label AS part_label/);
  assert.match(orders, /LEFT JOIN order_lines olo ON olo\.id = ol\.part_of_line_id/);
  assert.match(orders, /AND NOT EXISTS \(SELECT 1 FROM order_lines xl WHERE xl\.part_of_line_id = ol\.id\)\s*\n\s*ORDER BY ol\.order_id DESC, COALESCE\(ol\.part_of_line_id, ol\.id\), ol\.id/);
});

test('gangs: a part line can never join a gang or a combined run', () => {
  const gangs = src('./routes/gangs.js');
  assert.match(gangs, /ol\.id, ol\.order_id, ol\.qty, ol\.status, ol\.gang_run_id, ol\.part_of_line_id,/);
  assert.equal((gangs.match(/partLineGangBlock\(members\)/g) || []).length, 3);
  assert.match(gangs, /AS has_parts/);
});

test('every Planning / FG door that acts on one line refuses a carton made in parts', () => {
  const orders = src('./routes/orders.js');
  const fg = src('./routes/fg.js');
  assert.match(src('./helpers.js'), /export const hasPartLines = /);
  assert.ok((orders.match(/cartonLineBlock\(\{ hasParts: await hasPartLines\(/g) || []).length >= 3, 'plan, plan/discard, raise-pr');
  assert.ok((fg.match(/cartonLineBlock\(\{ hasParts: await hasPartLines\([^)]*\), isPart: /g) || []).length >= 2, 'consume-fg, fulfil-from-stock refuse a part too');
  // Artwork queue and plan_draft never treat a carton's zeros as a saved plan
  assert.match(orders, /AND NOT EXISTS \(SELECT 1 FROM order_lines xa WHERE xa\.part_of_line_id = ol\.id\)\s*\n\s*ORDER BY ol\.artwork_locked, o\.delivery_date NULLS LAST, ol\.id/);
  assert.match(orders, /AND NOT EXISTS \(SELECT 1 FROM order_lines xd WHERE xd\.part_of_line_id = ol\.id\)\) AS plan_draft/);
});

test('chip + one carton-wide board verdict', () => {
  assert.equal(partChipText({ part_of_line_id: 950, part_label: 'Part 1', outer_code: 'SW-715' }), 'Part 1 · for SW-715');
  assert.equal(partChipText({ part_of_line_id: null }), null);
  const rows = [
    { id: 1, part_of_line_id: 950, board_state: 'covered' },
    { id: 2, part_of_line_id: 950, board_state: 'short' },
    { id: 3, part_of_line_id: null, board_state: 'short' },
  ];
  assert.deepEqual(cartonBoardSummary(rows).get(950), { covered: 1, total: 2, state: 'short' });
  assert.equal(cartonBoardSummary(rows).has(3), false);
});
```

- [ ] **Step 2: Confirm it fails.**
  - Run: `cd server && node --test src/carton-parts-pins.test.js`
  - Expected: FAIL.

- [ ] **Step 3: Implement**

(a) **`LINE_VIEW`** (orders.js). Add to the select list, directly before `gg.gang_number, gg.kind AS run_kind`:
```sql
         -- Carton made in parts (carton-parts.js): a PART line names its carton;
         -- a CARTON line knows it has parts.
         ol.part_of_line_id, COALESCE(ol.part_label, pp.label) AS part_label,
         COALESCE(ol.part_per_carton, pp.per_carton) AS part_per_carton,
         po.code AS outer_code, po.name AS outer_name,
         EXISTS (SELECT 1 FROM order_lines xl WHERE xl.part_of_line_id = ol.id) AS has_parts,
```
Append after the final `LEFT JOIN tools dc …` line:
```sql
  LEFT JOIN order_lines olo ON olo.id = ol.part_of_line_id
  LEFT JOIN products po ON po.id = olo.product_id
  LEFT JOIN product_parts pp ON pp.outer_product_id = olo.product_id AND pp.part_product_id = ol.product_id
```
`routes/workflow.js:9` has its own LINE_VIEW copy. Leave it alone; nothing there needs part fields.

(b) **`GET /planning`**:
```js
    const rows = await q(`${LINE_VIEW}
      WHERE ol.status IN ('pending','planned','ready','in_production')
      -- A carton made in parts is never planned itself: its parts are (carton-parts.js).
      AND NOT EXISTS (SELECT 1 FROM order_lines xl WHERE xl.part_of_line_id = ol.id)
      ORDER BY ol.order_id DESC, COALESCE(ol.part_of_line_id, ol.id), ol.id`);
```
The order keeps a carton's parts together at the carton's place in the queue.

(c) **`gangs.js`**:
- In `MEMBER_VIEW`, first select line: `SELECT ol.id, ol.order_id, ol.qty, ol.status, ol.gang_run_id, ol.part_of_line_id,`. Add a column anywhere in its select list: `EXISTS (SELECT 1 FROM order_lines xl WHERE xl.part_of_line_id = ol.id) AS has_parts,`. Mind the trailing comma, and check the alias `xl` is not already used inside MEMBER_VIEW.
- Import `partLineGangBlock` from `../carton-parts.js`.
- In each of the three routes (`POST /gang-runs` ~988, `POST /merge-runs` ~1092, `POST /gang-runs/:id/add-lines` ~2584), directly after the `members` load, add:
```js
      const partBlock = partLineGangBlock(members);
      if (partBlock) throw Object.assign(new Error(partBlock), { status: 409 });
```

(d) **`client/src/lib/cartonParts.js`**:
```js
// Client side of a carton made in parts (server rules: server/src/carton-parts.js).
import { worstBoardStateOf } from './boardState.js';

// The chip under a part's product name in Planning.
export const partChipText = row => (row?.part_of_line_id
  ? `${row.part_label || 'Part'} · for ${row.outer_code || 'its carton'}` : null);

// One board verdict per carton, from its part rows on screen: how many parts
// are covered, and the worst state among them (the carton is only as ready
// as its scarcest board). Keyed by the carton line id.
export function cartonBoardSummary(rows = []) {
  const byCarton = new Map();
  for (const r of rows) {
    if (!r?.part_of_line_id) continue;
    if (!byCarton.has(r.part_of_line_id)) byCarton.set(r.part_of_line_id, []);
    byCarton.get(r.part_of_line_id).push(r);
  }
  const out = new Map();
  for (const [id, parts] of byCarton) {
    out.set(id, {
      covered: parts.filter(p => p.board_state === 'covered').length,
      total: parts.length,
      state: worstBoardStateOf(parts),
    });
  }
  return out;
}
```

(e) **`client/src/components/PartChip.jsx`**:
```jsx
import { partChipText } from '../lib/cartonParts.js';

// "Part 1 · for SW-715" + the whole carton's board at a glance.
export default function PartChip({ row, summary }) {
  const text = partChipText(row);
  if (!text) return null;
  const s = summary?.get(row.part_of_line_id);
  const tone = s?.state === 'covered' ? 'text-emerald-700' : s?.state === 'on_order' ? 'text-amber-700' : 'text-red-700';
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
      <span className="rounded-md border border-sky-200 px-1.5 py-0.5 font-semibold text-sky-700">{text}</span>
      {s && <span className={tone}>Carton board: {s.covered} of {s.total} parts covered</span>}
    </div>
  );
}
```

(f) **`Planning.jsx`**:
- Import `PartChip` and `cartonBoardSummary`.
- Compute `const cartonBoards = useMemo(() => cartonBoardSummary(rows), [rows]);`. `rows` = the list the table renders; use that variable's real name, found where `DataTable` receives its `rows=`. The rows must already carry `board_state` (stamped by `stampBoardState` in `planningRows`).
- In the non-gang branch of the Product cell (3831–3834), add `<PartChip row={l} summary={cartonBoards} />` directly before `<FluenceButton … className="mt-1" />`.

(g) **One carton-line guard on every Planning/FG door that acts on one line.** The carton is hidden from Planning, but a stale screen or a direct call must not plan it, void its zeros, raise a PR on the outer's board, or fill it from FG stock. Doing so would set it `produced` behind its parts' backs.
- In `helpers.js`, next to `partLinesOf`:
```js
// Is this line a carton made in parts? (It has part lines.) The cheap check the
// single-line Planning/FG doors ask before touching it (carton-parts.js cartonLineBlock).
export const hasPartLines = async (lineId, oc = one) =>
  !!(await oc('SELECT 1 AS x FROM order_lines WHERE part_of_line_id=$1 LIMIT 1', [lineId]));
```
- In each of these five routes, inside its transaction (or before its first write, if it has none), right after the route has its line id:
  - `orders.js`: `POST /order-lines/:id/plan` (1554), `POST /order-lines/:id/plan/discard` (2288), `POST /order-lines/:id/raise-pr` (3314);
  - `fg.js`: `POST /order-lines/:id/consume-fg` (268), `POST /order-lines/:id/fulfil-from-stock` (297).
  
  Add:
```js
      const cartonBlock = cartonLineBlock({ hasParts: await hasPartLines(<the line id>, oc) });
      if (cartonBlock) throw Object.assign(new Error(cartonBlock), { status: 409 });
```
  At the two **FG** doors (`consume-fg`, `fulfil-from-stock`) also refuse a PART. Its pieces come from its own card, and FG booked against a part would leave the pasting join waiting forever. Read the line's `part_of_line_id` (the route already loads the line; use its row) and write:
```js
      const cartonBlock = cartonLineBlock({ hasParts: await hasPartLines(<the line id>, oc), isPart: !!<the line row>.part_of_line_id });
```
  Use the route's own variable for the id and its own `oc` (or `one` outside a tx), and import `cartonLineBlock` / `hasPartLines`. Read each route first. If a route answers refusals with a structured body (e.g. `{ error, blockers }`), follow its pattern.
  Before that check, as the FIRST statement inside each of these five routes' transactions, take `SELECT pg_advisory_xact_lock_shared(hashtext('product_parts'))`, the same as order entry (Task 7 a2). A parts save committing between the unlocked `hasPartLines` read and the route's write would otherwise leave a converted carton planned with board figures (breaking C2). Pin it in each route.

(h) **The carton's zeros are not a saved plan.**
- `LINE_VIEW` `plan_draft` becomes:
```sql
         (ol.status = 'pending' AND ol.parent_sheets_required IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM order_lines xd WHERE xd.part_of_line_id = ol.id)) AS plan_draft,
```
- The Artwork queue (`orders.js` ~2951) must not list a carton. Its parts carry the artwork. Wrap its existing WHERE and exclude cartons, keeping the ORDER BY byte-identical (`artwork-row-stays-put.test.js` pins it):
```js
    const rows = await q(`${LINE_VIEW}
      WHERE (ol.status IN ('planned','ready','in_production')
         OR (ol.status = 'pending'
             AND (ol.parent_sheets_required IS NOT NULL OR ol.artwork_locked = 1)))
        AND NOT EXISTS (SELECT 1 FROM order_lines xa WHERE xa.part_of_line_id = ol.id)
      ORDER BY ol.artwork_locked, o.delivery_date NULLS LAST, ol.id`);
```
Run `node --test src/artwork-row-stays-put.test.js` afterwards. If it pins the WHERE text, update only the WHERE part of the pin and say so.

(i) **The rollback dialog on a PART row says the whole carton goes** (`client/src/components/WorkflowControls.jsx`, the rollback/delete modal ~236–244). Read how the component receives its row and decides `isDelete` / `label` first. When the row has `part_of_line_id`:
- **Rollback:** the summary reads `<b>{label}</b> is one part of {outer_code} — rolling it back rolls back the <b>whole carton</b>: every part returns to the sales order as a fresh Pending item, and all their planning, board holds, not-yet-ordered PRs and unstarted job cards are cleared.`
- **Delete:** the server refuses a part alone. Do not offer Delete on a part row; show the reason `Remove the carton in Orders → Edit` instead.
- **After a successful rollback:** show the server's `message` when the response carries one (it names the carton's parts). Keep the component's current text otherwise.

Pin, in `carton-parts-pins.test.js`: `assert.match(src('../../client/src/components/WorkflowControls.jsx'), /rolls back the <b>whole carton<\/b>/);`

(j) **Review fixes (Task 8 code review, each reproduced on Postgres):**
- **Chip on To Plan.** `server/src/planning-scope.js` partitions the list by carton as well as by gang: `gangIdOf: l => l.gang_run_id ?? (l.part_of_line_id != null ? \`carton:${l.part_of_line_id}\` : null)`. All parts of a carton then sit in the same half, and "Carton board: n of m" is right on To Plan.
- **Order-edit race at plan / raise-pr / discard.** Lock the line, then check with a fresh statement.
  - Plan and raise-pr: `SELECT id FROM order_lines WHERE id=$1 FOR KEY SHARE` before `hasPartLines`. In plan-save, after the gang block.
  - Discard: the check moves after its existing `FOR UPDATE`.
  - The reviewer's tested diff is `scratchpad/rev10/fix-proposal.diff`.
- **Gang doors race.** After loading the members, re-check with a fresh query (`SELECT DISTINCT part_of_line_id AS id FROM order_lines WHERE part_of_line_id = ANY($1)`) and set `has_parts` on the members it returns, in all four doors.
- **Chip colour.** It uses the same board-state fallback as Planning's own board column, so the count and the colour agree.
- **A part's quantity is not editable in the planning engine.** The box is read-only on part rows, and `/order-lines/:id/plan` refuses a qty change on a part line with 409 "a part's quantity follows its carton — change the carton in Orders → Edit".
- **No FG actions on part rows.** Part rows report `fg_available` 0, so no Use FG Stock or Complete from Stock is offered.
- **Search by carton code.** The Product column search includes the carton's code, so "SW-715" finds its parts.
- **Deep link to a carton.** `/planning?line=<carton>` opens the carton's first part instead of "left the queue".
- **The carton stays visible once pasting starts.** GET /planning hides a carton only while it has no job card of its own. Once its pasting card exists, it shows in the Completed tab like any pushed job. Rollback there is still refused by the pasting-card rule.
- **Pins** for the WorkflowControls part-row Delete gate, its delete guard and its rollback wording (the review's surviving mutants M14–M16), where a source pin can see them.

- [ ] **Step 4: Confirm it passes.**
  - Run: `cd server && node --test src/carton-parts-pins.test.js` → PASS.
  - Full suite: 0 new failures. Gang-route pins may slice `gangs.js` by character counts. If one fails because a block moved, widen that number just enough and say so; never weaken its regex.
  - `cd client && npm run build` → builds.

- [ ] **Step 5: Do not commit.**

---

### Task 9: Sales-facing views never count a part

**Files:**
- Modify: `server/src/routes/orders.js`:
  - orders list totals 218–221
  - `/sales/pendency` demand CTE at 728
- Modify: `server/src/routes/dispatch.js` (46, 80, 155, 262, 470, 589)
- Modify: `server/src/routes/dashboard.js` (28, 98, 263)
- Modify: `server/src/routes/orders.js` Status Sheet: `GET /status-sheet` (~829, WHERE at ~873) and the WIP match (~1211)

**The rule.** A query answers a **customer / sales / dispatch** question (what was ordered, what is pending, what can ship, how much, how many lines). If so, add `AND ol.part_of_line_id IS NULL`, or `AND part_of_line_id IS NULL` when the query has no alias. Do not add it to:
- **Order-completion counts that go by STATUS:** `COUNT(*) … status NOT IN ('dispatched','cancelled')` at dispatch.js 310/414/492/651/688 and orders.js 420/691. A part still in production must hold its order open, and a pasted part is already `dispatched`, so these are right as they are.
- **Planning, production, board and procurement queries.**

**But two completion checks do NOT go by status, and each MUST get the filter.** A pasted part keeps `completed_at` NULL and `dispatched_qty = 0` forever, so without it an order holding a carton can never complete:
- orders.js ~655, the `complete-lines` roll-up: `… AND status<>'cancelled' AND completed_at IS NULL AND part_of_line_id IS NULL`.
- orders.js ~685, `POST /orders/:id/status` → `completed`: `… AND status<>'cancelled' AND dispatched_qty < qty AND part_of_line_id IS NULL`.

Both are safe: a carton can only be fully dispatched after its pasting card exists, and by then every part is pasted.

- [ ] **Step 1: Add the failing pins**

```js
test('sales views exclude part lines; status-based completion counts do not; the two non-status ones do', () => {
  const orders = src('./routes/orders.js');
  assert.match(orders, /status<>'cancelled' AND completed_at IS NULL AND part_of_line_id IS NULL/);
  assert.match(orders, /status<>'cancelled' AND dispatched_qty < qty AND part_of_line_id IS NULL/);
  assert.match(orders, /AND ol\.qty > ol\.dispatched_qty AND ol\.completed_at IS NULL\s*\n\s*AND ol\.part_of_line_id IS NULL/);
  assert.match(orders, /FROM order_lines ol WHERE ol\.order_id=o\.id AND ol\.part_of_line_id IS NULL\) AS line_count/);
  assert.match(orders, /WHERE pl\.part_of_line_id = ol\.id\) AS parts,/);
  const dispatch = src('./routes/dispatch.js');
  assert.doesNotMatch(dispatch, /status NOT IN \('dispatched','cancelled'\) AND part_of_line_id/);
  // Status Sheet + WIP match: no part rows; a carton reads printed once every part printed
  assert.equal((orders.match(/WHERE \$\{STATUS_SHEET_SCOPE_SQL\} AND ol\.part_of_line_id IS NULL/g) || []).length, 2);
  assert.match(orders, /A carton made in parts is printed once EVERY part is/);
  assert.match(orders, /WHERE part_of_line_id=\$\$\{fvals\.length\}/);
});
```

- [ ] **Step 2: Confirm it fails.**

- [ ] **Step 3: Implement**
- **Orders list, 218–221.** Add `AND ol.part_of_line_id IS NULL` to each of the four sub-selects (`line_count`, `value`, `ordered_qty`, `fulfilled_qty`). For `line_count`: `WHERE ol.order_id=o.id AND ol.part_of_line_id IS NULL) AS line_count`.
- **Pendency CTE.** Add `AND ol.part_of_line_id IS NULL` under the `completed_at` condition. Then, for each carton row, carry its parts' progress for a chip by adding to the CTE select:
```sql
               (SELECT json_agg(json_build_object('label', COALESCE(pl.part_label, pp.label, pp2.name), 'status', pl.status,
                                                  'jc_status', pj.status) ORDER BY pp.seq, pl.id)
                  FROM order_lines pl
                  JOIN products pp2 ON pp2.id = pl.product_id
                  LEFT JOIN product_parts pp ON pp.outer_product_id = ol.product_id AND pp.part_product_id = pl.product_id
                  LEFT JOIN job_cards pj ON pj.order_line_id = pl.id
                 WHERE pl.part_of_line_id = ol.id) AS parts,
```
  In the client pendency page (`grep -rn "sales/pendency" client/src`), where a row's status or stage renders, add: when `row.parts?.length`, a line `Parts: Part 1 — die-cut ✓ · Part 2 — printing`. Die-cut ✓ when `jc_status === 'split'`; otherwise the part's status with `_` → space.
- **dispatch.js 46, 80, 155, 262, 470, 589.** Open each and apply the rule. A part line is never `produced` for more than one transaction (C5), so the ready/produced lists are already safe. Add the filter anyway wherever the query lists **lines of an order for a challan or a dispatch pick**, as a belt against a mid-flight read. Leave pure per-id reads (`WHERE id=$1`) alone.
- **dashboard.js 28, 98, 263.** Apply the rule to open-line and qty KPIs. 138 counts un-locked artwork on `planned` lines and is a planning KPI, so leave it.
- **Status Sheet** (customer-facing).
  - In `GET /status-sheet` and in the WIP-match query, change `WHERE ${STATUS_SHEET_SCOPE_SQL}` to `WHERE ${STATUS_SHEET_SCOPE_SQL} AND ol.part_of_line_id IS NULL`.
  - The carton has no printing stage of its own, so `printed_derived` must also read true once EVERY part has printed. Wrap the existing `EXISTS (…) AS printed_derived` as:
```sql
             (EXISTS (
               … the existing printing EXISTS, unchanged …
             )
             -- A carton made in parts is printed once EVERY part is (carton-parts.js).
             OR (EXISTS (SELECT 1 FROM order_lines pl WHERE pl.part_of_line_id = ol.id)
                 AND NOT EXISTS (
                   SELECT 1 FROM order_lines pl WHERE pl.part_of_line_id = ol.id
                     AND NOT EXISTS (SELECT 1 FROM job_cards pj JOIN job_stages ps ON ps.job_card_id = pj.id
                                     WHERE pj.order_line_id = pl.id AND ps.stage = 'printing' AND ps.status = 'completed')))
             ) AS printed_derived
```
  - **Tracking and shade cards** (from the Task 5 review):
    - `floor.js` `GET /track` lists no part lines (`ol.part_of_line_id IS NULL`).
    - `/track/:id` on a carton made in parts shows its parts' progress instead of "Waiting for plan lock", because a `sheets_required` of 0 reads as unplanned.
    - `/track/:id` on a part line answers for its carton.
    - `shadecards.js` ~155: a finished part card (`status='split' AND gang_run_id IS NULL`) is not live work. Gang parents stay as they are.
  - The live stage chips stay the carton's own (its pasting card). Showing part cards there would repeat stage names, which the "Where it is" rail does not model: a v1 limit.
  - **Parts follow their carton's EDD and P1.** In `PATCH /status-sheet/line/:id` (~941), after the carton line's own UPDATE:
```js
    // A carton made in parts: its parts are planned and printed against the
    // carton's own date and priority (carton-parts.js). WIP / remarks / printed
    // stay the carton's — the customer chases the carton, not its pieces.
    const follow = [];
    const fvals = [];
    if ('delivery_date' in req.body) { fvals.push(req.body.delivery_date || null); follow.push(`delivery_date=$${fvals.length}`); }
    if ('is_p1' in req.body) { fvals.push(req.body.is_p1 ? 1 : 0); follow.push(`is_p1=$${fvals.length}`); }
    if (follow.length) {
      fvals.push(id);
      await q(`UPDATE order_lines SET ${follow.join(', ')} WHERE part_of_line_id=$${fvals.length}`, fvals);
    }
```
    The order-level EDD edit (`/status-sheet/order/:id`) already clears every line's override, parts included, so it needs nothing.

**As built, follow-ups (coordinator-requested, proven):**
- **Shade cards against a part.** The pendency `parts` JSON carries `line_id`, `product_id`, `code`, `label`, `qty` and `stage`. `client/src/pages/shade-cards/ShadeCardForm.jsx` offers each part after its carton.
- **Dashboard.** The ready-to-dispatch tile skips parts.
- **Pendency buckets.** One rule, `pendencyFloor` (orders.js), sets `on_floor` / `wip_qty`: a carton with any part card is On the floor until its pasting card exists.
- **Chip stage.** It reads "Part 1 — printing".
- **Track.** One status rule serves the pill and the header. Before the pasting card, a carton's Artwork, Tooling and Job-card steps derive from its parts.
- **Atomic follow.** The EDD/P1 follow runs in one transaction with the carton edit.

**Still to settle in review:**
- **Track after pasting.** Once the pasting card exists, the carton's own Tooling step ("Die missing") and "sheets issued" (really cartons) come back on Track.
- **Pendency Status badge.** It reads "Production Required" for a carton whose parts are carded.

- [ ] **Step 4: Confirm it passes.** Pins pass, full suite shows 0 new failures, and the client builds.

- [ ] **Step 5: Do not commit.**

---

### Task 10: The printed job card says what it is

**Files:**
- Create: `client/src/components/JobCardPartsBand.jsx`
- Modify: `client/src/components/JobCardSheet.jsx` (directly under the `<h1>` with `jc.jc_number`, line 239)

- [ ] **Step 1: Pin it**

```js
test('job card sheet renders the parts band', () => {
  const sheet = src('../../client/src/components/JobCardSheet.jsx');
  assert.match(sheet, /import JobCardPartsBand from '\.\/JobCardPartsBand\.jsx'/);
  assert.match(sheet, /<h1[^>]*>\{jc\.jc_number\}<\/h1>\s*\n\s*<JobCardPartsBand jc=\{jc\} \/>/);
});
```

- [ ] **Step 2: Confirm it fails.**

- [ ] **Step 3: Implement**

```jsx
// What a carton-in-parts card IS, printed where the operator looks first.
// Payload: GET /job-cards/:id → jc.carton_parts (production.js attachCartonParts).
export default function JobCardPartsBand({ jc }) {
  const cp = jc?.carton_parts;
  if (!cp) return null;
  const fmt = n => (n == null ? '—' : Number(n).toLocaleString('en-IN'));
  return (
    <div className="mt-1 rounded-md border-2 border-sky-600 px-2 py-1 text-[13px] font-semibold text-sky-800">
      {cp.role === 'part'
        ? <>{cp.label} of {cp.of_parts} · for {cp.outer_code} {cp.outer_name} — runs to die cutting; the pieces are pasted into the carton on its pasting card</>
        : <>Pasting card — joins {cp.parts.map(p => `${p.label} (${p.jc_number || 'not yet'}: ${fmt(p.qty_produced)} pcs)`).join(' + ')}</>}
    </div>
  );
}
```
Import it in `JobCardSheet.jsx` and render `<JobCardPartsBand jc={jc} />` on the line directly after the `<h1 …>{jc.jc_number}</h1>`. Batch print (`JobCardBatchPrint.jsx`) feeds the same sheet. If its payload does not come from `GET /job-cards/:id`, check with `grep -n "api.get" client/src/pages/JobCardBatchPrint.jsx`. If it uses a different route, call `attachCartonParts` there too (production.js:704 is the second `attachBoardMix` caller).

- [ ] **Step 4: Confirm it passes.** Pins pass and the client builds.

- [ ] **Step 5: Do not commit.**

---

### Task 11: Real-Postgres flow test

**Files:**
- Create: `server/src/carton-parts-flow-pg.test.js`

- [ ] **Step 1: Write the test.** It is opt-in, like `product-code-routes-pg.test.js`, whose harness it copies: `freePort`, `EmbeddedPostgres`, `db.init()`, express with a stub admin user.

```js
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// A carton made in parts, end to end on a real Postgres with the app's schema:
// PO → hidden part lines → each part on its own board → part cards end at die
// cutting → pasting card sized to the scarcer part → FG only ever the carton.
//
//   CARTON_PARTS_PG=1 node --test src/carton-parts-flow-pg.test.js

const ENABLED = process.env.CARTON_PARTS_PG === '1';
const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.unref();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

describe('carton made in parts — the whole flow', {
  skip: ENABLED ? false : 'set CARTON_PARTS_PG=1 to boot a throwaway Postgres',
}, () => {
  let epg, dir, db, helpers, cpdb, server, base;
  const ids = {};

  before(async () => {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carton-parts-'));
    const port = await freePort();
    epg = new EmbeddedPostgres({ databaseDir: dir, port, user: 'postgres', password: 'postgres',
      persistent: false, onLog: () => {}, onError: () => {} });
    await epg.initialise(); await epg.start();
    process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
    db = await import('./db.js'); await db.connect(); await db.init();
    helpers = await import('./helpers.js');
    cpdb = await import('./carton-parts-db.js');

    const one = db.one;
    ids.cust = (await one(`INSERT INTO customers (name) VALUES ('Swiss Garnier Life Sciences') RETURNING id`)).id;
    ids.boardA = (await one(`INSERT INTO materials (name, category, sheet_l, sheet_w) VALUES ('Saffire 290 20x38','board',20,38) RETURNING id`)).id;
    ids.boardB = (await one(`INSERT INTO materials (name, category, sheet_l, sheet_w) VALUES ('Saffire 290 12x18','board',12,18) RETURNING id`)).id;
    const prod = (code, name, board, ups, l, w) => one(
      `INSERT INTO products (customer_id, name, code, board_material_id, ups, child_l, child_w, parent_l, parent_w)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$6,$7) RETURNING id`, [ids.cust, name, code, board, ups, l, w]);
    ids.outer = (await prod('SW-715', 'VOGEAB GM2 OUTER', ids.boardA, 2, 12, 18)).id;
    ids.p1 = (await prod('SW-715-P1', 'VOGEAB GM2 OUTER PART 1', ids.boardA, 4, 20, 38)).id;
    ids.p2 = (await prod('SW-715-P2', 'VOGEAB GM2 OUTER PART 2', ids.boardB, 2, 12, 18)).id;
    ids.outer2 = (await prod('SW-716', 'VOGEAB GM2 OUTER /a', ids.boardA, 2, 12, 18)).id;
    for (const [m, qty] of [[ids.boardA, 50000], [ids.boardB, 50000]]) {
      await db.q(`INSERT INTO stock_batches (material_id, batch_no, qty, initial_qty, unit, status)
                  VALUES ($1,'T-1',$2,$2,'sheets','available')`, [m, qty]);
    }

    const { default: express } = await import('express');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { id: 1, role: 'admin', name: 'parts test' }; next(); });
    for (const f of ['./routes/orders.js', './routes/product-parts.js']) app.use('/api', (await import(f)).default);
    app.use((e, _req, res, _next) => res.status(e.status || 500).json({ error: e.message }));
    server = app.listen(0);
    base = `http://127.0.0.1:${server.address().port}/api`;
  });

  after(async () => {
    server?.close();
    try { await (await db?.connect())?.end(); } catch {}
    try { await epg?.stop(); } catch {}
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const partLines = () => db.q('SELECT * FROM order_lines WHERE part_of_line_id=$1 ORDER BY product_id', [ids.line]);

  test('a PO booked BEFORE the parts exist converts when the parts are saved', async () => {
    const po = await call('POST', '/orders', { po_number: '02545', customer_id: ids.cust,
      lines: [{ product_id: ids.outer, qty: 11500, line_remark: 'B-7' }] });
    assert.equal(po.status, 200);
    ids.line = (await db.one('SELECT id FROM order_lines WHERE order_id=$1', [po.body.id])).id;
    assert.equal((await partLines()).length, 0);

    const bad = await call('PUT', `/products/${ids.outer}/parts`, { parts: [{ part_product_id: ids.p1, label: 'Part 1' }] });
    assert.equal(bad.status, 400);
    const ok = await call('PUT', `/products/${ids.outer}/parts`, { parts: [
      { part_product_id: ids.p1, label: 'Part 1', per_carton: 1 },
      { part_product_id: ids.p2, label: 'Part 2', per_carton: 1 },
    ] });
    assert.equal(ok.status, 200);
    const parts = await partLines();
    assert.deepEqual(parts.map(p => [p.product_id, p.qty, p.line_remark, +p.rate]), [[ids.p1, 11500, 'B-7', 0], [ids.p2, 11500, 'B-7', 0]]);
    const outer = await db.one('SELECT * FROM order_lines WHERE id=$1', [ids.line]);
    assert.deepEqual([outer.sheets_required, outer.parent_sheets_required], [0, 0]);
  });

  test('editing the carton qty moves both parts; a second PO line syncs on create', async () => {
    const order = await db.one('SELECT * FROM orders WHERE po_number=$1', ['02545']);
    const res = await call('PUT', `/orders/${order.id}`, { po_number: '02545', customer_id: ids.cust,
      lines: [{ id: ids.line, product_id: ids.outer, qty: 12000, rate: 0, line_remark: 'B-7' }] });
    assert.equal(res.status, 200);
    assert.deepEqual((await partLines()).map(p => p.qty), [12000, 12000]);
  });

  test('Planning hides the carton and shows both parts, each on its own board', async () => {
    const res = await fetch(`${base}/planning`);
    const rows = await res.json();
    const list = Array.isArray(rows) ? rows : rows.rows;
    assert.equal(list.some(r => r.id === ids.line), false);
    const mine = list.filter(r => r.part_of_line_id === ids.line);
    assert.deepEqual(mine.map(r => r.board_material_id).sort(), [ids.boardA, ids.boardB].sort());
    assert.deepEqual(mine.map(r => r.part_label), ['Part 1', 'Part 2']);
  });

  test('parts cannot be cancelled alone; the carton cannot get a plain card', async () => {
    const [p1] = await partLines();
    const cancel = await call('POST', `/order-lines/${p1.id}/cancel`, {});
    assert.equal(cancel.status, 409);
    await assert.rejects(() => db.tx((qc, oc) => helpers.createJobCardForLine(ids.line, qc, oc, 'test')), /made in parts/);
  });

  test('each part card ends at die cutting; the pasting card waits for BOTH', async () => {
    // Stand in for Planning: lock each part line as a planner would, then push.
    for (const p of await partLines()) {
      await db.q(`UPDATE order_lines SET status='ready', artwork_locked=1, sheets_required=$2, parent_sheets_required=$2 WHERE id=$1`,
        [p.id, Math.ceil(p.qty / (p.product_id === ids.p1 ? 4 : 2)) + 200]);
    }
    const cards = [];
    for (const p of await partLines()) cards.push(await db.tx((qc, oc) => helpers.createJobCardForLine(p.id, qc, oc, 'test')));
    for (const c of cards) {
      const st = await db.q('SELECT stage FROM job_stages WHERE job_card_id=$1 ORDER BY seq', [c]);
      assert.equal(st.at(-1).stage, 'die_cutting');
      assert.equal(st.some(s => ['sorting', 'pasting'].includes(s.stage)), false);
    }

    // Part 1: 3,050 sheets × 4 ups = 12,200 pieces. The carton waits for Part 2.
    const jc1 = await db.one('SELECT * FROM job_cards WHERE id=$1', [cards[0]]);
    await db.tx(async (qc, oc) => { await cpdb.closePartCard(jc1, 3050, qc, oc, 'test'); });
    assert.equal(await db.tx((qc, oc) => cpdb.maybeCreateAssemblyCard(ids.line, qc, oc, 'test')), null);

    // The master's parts list is CLEARED while Part 2 is still on the floor: the
    // parts on this order are frozen, and they — not the master — decide pasting.
    const cleared = await call('PUT', `/products/${ids.outer}/parts`, { parts: [] });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    assert.match(cleared.body.warnings.join(' '), /already on the floor/);
    assert.equal((await partLines()).length, 2);

    // Part 2: 6,020 sheets × 2 ups = 12,040 pieces → 12,040 cartons, 160 spare Part 1.
    const jc2 = await db.one('SELECT * FROM job_cards WHERE id=$1', [cards[1]]);
    await db.tx(async (qc, oc) => { await cpdb.closePartCard(jc2, 6020, qc, oc, 'test'); });
    const asm = await db.tx((qc, oc) => cpdb.maybeCreateAssemblyCard(ids.line, qc, oc, 'test'));
    const card = await db.one('SELECT * FROM job_cards WHERE id=$1', [asm]);
    assert.deepEqual([card.is_assembly, card.qty_planned, card.product_id, card.order_line_id], [true, 12040, ids.outer, ids.line]);
    assert.deepEqual((await db.q('SELECT stage FROM job_stages WHERE job_card_id=$1 ORDER BY seq', [asm])).map(s => s.stage),
      ['sorting', 'pasting']);
    assert.deepEqual((await partLines()).map(p => p.status), ['dispatched', 'dispatched']);
    const carton = await db.one('SELECT status, sheets_required, parent_sheets_required FROM order_lines WHERE id=$1', [ids.line]);
    assert.deepEqual([carton.status, carton.sheets_required, carton.parent_sheets_required], ['in_production', 0, 0]);
    // nothing but the carton may ever reach FG
    assert.equal((await db.q('SELECT 1 FROM fg_stock WHERE product_id = ANY($1::int[])', [[ids.p1, ids.p2]])).length, 0);
    // with the master cleared, each part still carries its own remembered label (C9)
    const audit = await db.one(`SELECT detail FROM audit_log WHERE entity='job_card' AND entity_id=$1 AND action='create_assembly'`, [asm]);
    assert.match(audit.detail, /12040 cartons — spare Part 1 160/);

    // Put the parts back for the tests that follow.
    const again = await call('PUT', `/products/${ids.outer}/parts`, { parts: [
      { part_product_id: ids.p1, label: 'Part 1', per_carton: 1 },
      { part_product_id: ids.p2, label: 'Part 2', per_carton: 1 },
    ] });
    assert.equal(again.status, 200, JSON.stringify(again.body));
  });

  test('pendency shows one carton line with its parts, never a part line', async () => {
    const rows = await (await fetch(`${base}/sales/pendency`)).json();
    const list = Array.isArray(rows) ? rows : rows.rows;
    assert.equal(list.some(r => r.product_id === ids.p1 || r.product_id === ids.p2), false);
  });

  test('an order holding a pasted carton completes through both doors', async () => {
    const order = await db.one('SELECT o.* FROM orders o JOIN order_lines ol ON ol.order_id=o.id WHERE ol.id=$1', [ids.line]);
    // Stand in for Sort & Paste + dispatch: the carton shipped in full; its
    // parts were pasted (dispatched, dispatched_qty 0, completed_at NULL).
    await db.q(`UPDATE order_lines SET status='dispatched', dispatched_qty=qty WHERE id=$1`, [ids.line]);
    const lines = await call('POST', `/orders/${order.id}/complete-lines`, { line_ids: [ids.line] });
    assert.equal(lines.status, 200, JSON.stringify(lines.body));
    assert.equal(lines.body.order_completed, true);
    // The status door too: reopen (admin), then complete again.
    assert.equal((await call('POST', `/orders/${order.id}/status`, { status: 'pending' })).status, 200);
    const done = await call('POST', `/orders/${order.id}/status`, { status: 'completed' });
    assert.equal(done.status, 200, JSON.stringify(done.body));
  });

  test('rolling back ONE part rolls back its whole carton — every part, the audited way', async () => {
    const po = await call('POST', '/orders', { po_number: 'PO-RB-1', customer_id: ids.cust,
      lines: [{ product_id: ids.outer, qty: 300 }] });
    assert.equal(po.status, 200);
    const carton = await db.one('SELECT id FROM order_lines WHERE order_id=$1 AND part_of_line_id IS NULL', [po.body.id]);
    const parts = await db.q('SELECT id FROM order_lines WHERE part_of_line_id=$1 ORDER BY product_id', [carton.id]);
    await db.q(`UPDATE order_lines SET status='planned', sheets_required=200, parent_sheets_required=100
                WHERE id = ANY($1::int[])`, [parts.map(p => p.id)]);
    await db.q(`INSERT INTO board_allocations (material_id, order_line_id, qty, source) VALUES ($1,$2,50,'stock')`,
      [ids.boardB, parts[1].id]);
    const res = await call('POST', `/order-lines/${parts[0].id}/rollback`, { mode: 'rollback' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const after = await db.q('SELECT status, parent_sheets_required FROM order_lines WHERE id = ANY($1::int[]) ORDER BY id',
      [parts.map(p => p.id)]);
    assert.deepEqual(after.map(p => [p.status, p.parent_sheets_required]), [['pending', null], ['pending', null]]);
    assert.equal((await db.q(`SELECT 1 FROM board_allocations WHERE order_line_id=$1 AND status='active'`, [parts[1].id])).length, 0);
    const c = await db.one('SELECT status, sheets_required, parent_sheets_required FROM order_lines WHERE id=$1', [carton.id]);
    assert.deepEqual([c.status, c.sheets_required, c.parent_sheets_required], ['pending', 0, 0]);
  });

  test('deleting a carton undoes each part the one audited way — PR gone, hold released on record', async () => {
    const po = await call('POST', '/orders', { po_number: 'PO-DEL-1', customer_id: ids.cust,
      lines: [{ product_id: ids.outer, qty: 500 }] });
    assert.equal(po.status, 200);
    const carton = await db.one('SELECT id FROM order_lines WHERE order_id=$1 AND part_of_line_id IS NULL', [po.body.id]);
    const parts = await db.q('SELECT id FROM order_lines WHERE part_of_line_id=$1 ORDER BY product_id', [carton.id]);
    assert.equal(parts.length, 2);
    // Raise PR has no status gate, so a PENDING part can carry a PR and a hold.
    await db.q(`INSERT INTO requisitions (pr_number, material_id, qty, order_line_id) VALUES ('PR-T-1',$1,300,$2)`, [ids.boardB, parts[1].id]);
    await db.q(`INSERT INTO board_allocations (material_id, order_line_id, qty, source) VALUES ($1,$2,120,'stock')`, [ids.boardA, parts[0].id]);

    const alone = await call('POST', `/order-lines/${parts[0].id}/rollback`, { mode: 'delete' });
    assert.equal(alone.status, 409);
    assert.match(alone.body.error, /one part of a carton/);

    const res = await call('POST', `/order-lines/${carton.id}/rollback`, { mode: 'delete' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await db.q('SELECT 1 FROM order_lines WHERE id = ANY($1::int[])', [[carton.id, ...parts.map(p => p.id)]])).length, 0);
    assert.equal((await db.q(`SELECT 1 FROM requisitions WHERE pr_number='PR-T-1'`)).length, 0);
    const released = await db.q(`SELECT detail FROM audit_log WHERE entity='materials' AND action='board_hold_released'
                                  AND detail LIKE $1`, [`%order line #${parts[0].id}%`]);
    assert.equal(released.length, 1);
  });

  test('deleting a whole order that holds a carton removes carton and parts', async () => {
    const po = await call('POST', '/orders', { po_number: 'PO-DEL-2', customer_id: ids.cust,
      lines: [{ product_id: ids.outer, qty: 200 }] });
    assert.equal(po.status, 200);
    assert.equal((await db.q('SELECT 1 FROM order_lines WHERE order_id=$1', [po.body.id])).length, 3);
    const del = await call('DELETE', `/orders/${po.body.id}`, {});
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.equal((await db.q('SELECT 1 FROM order_lines WHERE order_id=$1', [po.body.id])).length, 0);
    assert.equal((await db.q('SELECT 1 FROM orders WHERE id=$1', [po.body.id])).length, 0);
  });

  test('a carton already planned as ONE job converts the one audited way when its parts are saved', async () => {
    const po = await call('POST', '/orders', { po_number: 'PO-CONV', customer_id: ids.cust,
      lines: [{ product_id: ids.outer2, qty: 800 }] });
    const line = await db.one('SELECT * FROM order_lines WHERE order_id=$1', [po.body.id]);
    await db.q(`UPDATE order_lines SET status='planned', sheets_required=600, parent_sheets_required=300 WHERE id=$1`, [line.id]);
    await db.q(`INSERT INTO requisitions (pr_number, material_id, qty, order_line_id) VALUES ('PR-T-2',$1,300,$2)`, [ids.boardA, line.id]);
    const ok = await call('PUT', `/products/${ids.outer2}/parts`, { parts: [
      { part_product_id: ids.p1, label: 'Part 1' }, { part_product_id: ids.p2, label: 'Part 2' },
    ] });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const after = await db.one('SELECT * FROM order_lines WHERE id=$1', [line.id]);
    assert.deepEqual([after.status, after.sheets_required, after.parent_sheets_required], ['pending', 0, 0]);
    assert.equal((await db.q(`SELECT 1 FROM requisitions WHERE pr_number='PR-T-2'`)).length, 0);
    assert.equal((await db.q('SELECT 1 FROM order_lines WHERE part_of_line_id=$1', [line.id])).length, 2);
  });
});
```

**Race test (same step).** Create `server/src/carton-parts-lock-order-pg.test.js`, opt-in with the same `CARTON_PARTS_PG=1`, modelled on `server/src/gang-lock-order-pg.test.js` (read it first: its harness and how it waits for a blocked backend in `pg_locks` / `pg_stat_activity`). It proves a carton is locked NO KEY UPDATE:
- **Fixture:** a carton line with two part lines (`part_of_line_id` set, pending). Part 1 must have the LOWER id.
- **Client A** (a raw `pg` client): `BEGIN; UPDATE order_lines SET status='planned' WHERE id=<part1>`. Its first update holds Part 1's row.
- **The app** (`db.tx`): `rollbackLine({ lineId: <part2>, mode: 'rollback' })`. That redirects to the carton, locks it, and the cascade then waits on Part 1's row. Start it, and wait until its backend shows as waiting on a lock.
- **Client A:** `UPDATE order_lines SET status='pending' WHERE id=<part1>`. A second update of a row this transaction already updated re-checks `part_of_line_id` and takes KEY SHARE on the carton. Then `COMMIT`.
- **Assert:** client A's second update succeeded, and the rollback promise resolved. No `40P01`.
- **Mutation check:** force the carton lock back to `line: 'UPDATE'`. The test must then fail with `deadlock detected`. Restore, and it passes.
- **Two more schedules, same file.** Pasting-card creation takes the order and the product before the carton:
  - **(ii) Order edit against a die-cut.** The ORDER of steps matters: the deadlock needs A's carton write to land AFTER the app would already hold the carton.
    - Client A: `BEGIN; SELECT id FROM orders WHERE id=<order> FOR UPDATE`.
    - The app, once both part cards are `split`: start `maybeCreateAssemblyCard(<carton>)` and wait until its backend is waiting on a lock. With the fix it waits on the order's KEY SHARE, before the carton.
    - Client A: `UPDATE order_lines SET qty=qty WHERE id=<carton>`, then `COMMIT`.
    - Assert: A's update succeeded, and the app created the card. No `40P01`.
    - Mutation: with the two `FOR KEY SHARE` lines removed, the app takes the carton first, then waits on the order inside its second carton update. A's carton write then waits on the app, giving `40P01`.
  - **(iii) Parts save against a die-cut:** as (ii), with client A locking the outer PRODUCT (`FOR UPDATE`, the old parts-save lock) instead of the order. The fix gives no deadlock; the mutant gives `40P01`.

**Added cases (as built through the reviews; each proven ad hoc during Tasks 5–9, and now made permanent).** Add them to the same flow file, mounting the extra routers they need (`production.js`, `fg.js`, `gangs.js`, `import.js`, `floor.js`) with the same stub admin. Read the current routes for exact bodies and messages; the texts below are the ones in the code today.
- **Import recognises parts:** `POST /orders/import/rematch` with rows naming the carton, a part by its code, and a part by name. The carton row is matched. Each part row comes back `suggested`, with the carton among its suggestions and a `part_note` that names the carton.
- **Duplicate-carton warning:** POST /orders with SW-715 on two lines returns 200 with a warning that matches `/is made in parts and is on 2 lines/`. POST with a part product as its own line returns a warning matching `/is a part of/`.
- **Planning doors refuse the carton:**
  - `/order-lines/:id/plan`, `/plan/discard`, `/raise-pr`, `/consume-fg` and `/fulfil-from-stock` on the CARTON → 409 with `cartonLineBlock`'s message;
  - `/consume-fg` on a PART → 409 with the part message;
  - `POST /gang-runs` with a part + an ordinary line → 409.
- **The real die-cut completion creates the pasting card.** Drive a part card's `die_cutting` stage through the real start and `POST /job-stages/:id/complete` routes. Earlier stages may be completed via SQL. The first part's completion leaves the card `split` with no pasting card; the second creates it. Starting its sorting stage issues no board.
- **Sales views:**
  - `/sales/pendency` has one row for the carton, with a `parts` array, and no part rows;
  - `/status-sheet` has no part rows;
  - `/track` lists no part lines;
  - the orders list counts the carton, not its parts.

Check the audit table name and columns before running: `grep -n "CREATE TABLE IF NOT EXISTS audit" server/src/db.js`. Adjust the SELECT to the real names (`audit_log` / `entity` / `entity_id` / `action` / `detail` are the expected shape). If `createJobCardForLine` refuses on another readiness gate (e.g. tooling), make the fixture satisfy it. **Never** weaken an assertion about part lines, stages, qty or FG.

- [ ] **Step 2: Run it.**
  - Run: `cd server && CARTON_PARTS_PG=1 node --test src/carton-parts-flow-pg.test.js`
  - Expected: PASS, 11 tests plus the added cases. Fix the implementation, not the test, unless a fixture detail was wrong. Where a message in this text differs from the code, the code's current wording wins, provided it says the same thing.

- [ ] **Step 3: Do not commit.**

---

### Task 12: Verify the whole thing locally

- [ ] **Step 1: Full server suite.**
  - Run: `cd server && node --test src/*.test.js 2>&1 | tail -8`
  - Expected: baseline + new tests, **0 fail**.
- [ ] **Step 2: Baseline + build.** Run `npm run verify` from the repo root: baseline check, server tests, client build. All green.
- [ ] **Step 3: See it in the real app, locally only.**
  - Start the worktree's own server + vite with its own embedded PG, following [[ci-erp-verify-ui-without-a-password]] and [[ci-erp-verify-worktree-setup-traps]]. **Never** point it at prod or the shared `:5439`.
  - Seed a customer, two boards of different sizes, an outer and two part products.
  - Walk through: Masters → outer → Made in parts → save. Orders → new PO for the outer. Planning shows **2 part rows, no carton row**, each with its own board and "Carton board: n of 2 parts covered". Push both parts. Job card print shows the band.
  - Screenshot Planning and the printed band. Check the browser console for errors.
- [ ] **Step 3b: A 0-carton pasting card.** The Sort & Paste form needs at least one pasting row with input > 0 (`production.js` ~3058/3178). So a card made for 0 sets closes through the per-stage Complete (0 good), then the carton's line closes short into the shortage re-raise. Walk it once locally and record what the screen offers. If it cannot be closed, report it; do not paper over it.
  - Result (Task 12, 2026-09-30): the 0-set card started at Sort & Paste, but its form showed "0 cartons received" with Complete and Save Day Count disabled — a dead end. It closed only from the Job Cards page (per stage, 0 good), whose toast wrongly said "FG added to stock". The carton then showed in the Shortage tab, and "Send to Planning" re-raised it with fresh part lines.
  - Fixed in Task 13b (J): a 0-set pasting card shows one button, **"Close — nothing to paste"**, in all three Sort & Paste queue layouts. The confirm takes the line-clearance checklist. The button completes sorting then pasting at 0 through the same per-stage calls the Job Cards page makes. The toast now says "CI-JC-… closed with nothing made — SW-715 is in the Shortage tab", and the carton shows there as "Nothing made". The 0-quantity stock receipt is still written, as for any card closed at 0.
- [ ] **Step 4: Do not commit.** Report back with the test counts, the screenshots, and every place a step's anchor had moved.

### Task 13: Fixes from the final whole-feature review and the Task 12 walkthrough (as built)

**Final review verdict (2026-09-30):** ready with fixes, no Critical. The deploy traps were checked and are safe:
- Vercel bundle: static imports; `api/index.js` never calls `init()`.
- Realtime pings on `product_parts`.
- PgBouncer: `SET LOCAL` only.
- Indexes behind every new lookup.

**13a: server fixes.** Suite 3658 / 3657 pass / 0 fail / 1 skipped. After the review fix, PG flow + lock-order is 40/40, also with `PG_POOL_MAX=1`. The review added (viii), the cross-carton strength case, and the print-state precedence pins. Every fix has a test that fails when the fix is reverted.
- **A. A carton edit racing a push.** `syncPartLines` locks, ON WRITE only, the parts its unlocked read found still in planning: unlocked read → lock those in id order → re-read → decide again. A part already past planning keeps its first reading and is never waited on. A qty edit or list change can no longer land on a part that went under way a moment ago.
  - Lock-order tests (v) and (vi) prove it.
  - (vii) proves an edit that leaves the carton alone never waits.
  - (viii) proves an edit never waits on a part past planning that another save writes twice (a reverse to Planning, an artwork unlock, a re-plan). The 13a review caught that deadlock, and it was fixed on 10-01.
  - In each case the lock-everything version deadlocked: a part written twice KEY SHAREs the order while PUT holds it FOR UPDATE.
- **B. A shade card on a part.** A 23503 (FK) raised while removing a part is contained like a blocker. That order keeps its list with "Part 1 has a shade card raised against it"; the rest of the parts save goes through.
- **D. A part's qty in plan-save.** The stored qty is kept, not refused: audit and response `part_qty_kept`, plus a toast note.
- **E. Repeated warnings.** Part-sync warnings in an order save show only for lines that save created or changed (qty, batch or product). This is `saidFor`.
- **F. Plain wording.**
  - Indian number grouping.
  - The cancel advice is true at each point (`partSays`: "already cleared for its job card", "already in production", "already die-cut", "already pasted").
  - "If its die-cut count is wrong, ask an admin to correct it."
  - One-sentence pasting refusal (`pastingCantStart`).
  - `PART_LINES_SQL` carries `jc_status`.
- **G1.** `PUT /job-cards/:id` returns `carton_parts`, so the band no longer disappears after a save.
- **G3.** A part line copies the carton's `is_p1` when it is created.
- **I. Status Sheet Print Status for a carton.** Read from its parts through `print_state` (`cartonPrintState`), which `printState` prefers.
  - A synthesized printing stage was rejected: `lineStageOf` would have called the carton done.
  - A part carded but not printing reads "Queued".
- **K. Strength alarm.** Two parts of the SAME carton never trip Print Planning's strength mix-up alarm.
- **H1. Pins.** The pins that counted guard doors exactly now say "at least".

**13b: screen and print fixes.** Suite 3665 / 3664 pass / 0 fail / 1 skipped. PG 40/40. Each fix was undone once to check its test goes red: 17 of 17 did.
- **C. The printed job card knows what it is** (`jc.is_assembly`, `jc.part_of_line_id`).
  - A pasting card prints "No board — this card pastes the pieces from its parts' job cards" and "Cartons to Paste" in place of the board and cutting box and Parent Sheets Issued.
  - A part card shows its Ordered and Produced quantities in pcs.
  - Ordinary and split-gang-child cards are unchanged.
- **G2.** The Import PO wizard shows the order-save warnings (doubled carton, part booked alone) as Orders does.
- **G4.** No AVS switch on a pasting card's editor.
- **H2.** A comment corrected.
- **J.** "Close — nothing to paste" (see Task 12 Step 3b). Sort & Paste asks `GET /job-cards/:id` only for cards planned at 0, because the station rows don't carry `is_assembly`.
- **L.** Planning's "Cartons to Make" counts a carton made in parts once: a part's qty ÷ its pieces per carton, once per carton (`cartonQtyOf`). For 5,000 SW-715 in 2 parts plus a 3,000 inner it reads 8,000, not 13,000.

**14: Sort & Paste queue Qty (asked for by Anik, 2026-10-01).** A pasting card waiting at Sort & Paste showed Qty 0 until Start: nothing upstream on its own card counts toward it, and Start had not stamped its input yet.
- **The fix:** the queue rows now tell `receiptFor` the input Start will stamp (`plannedIn`: the card's planned cartons), for a first-stage sorting row only. `received` shows it while the card waits.
- **Also fixed:** a split gang child's card is the same shape and showed 0 the same way, so it now shows its planned cartons too.
- **Shown figure only:** `live` and `ceiling` are unchanged, and `stageReceipt()` is not told, so nothing a save is capped or closed against moves.
- **Tests:** a `stage-runs.test.js` unit test, the die-cut flow test (the `GET /floor/sort-paste` row reads 2,020 before and after Start), and a pin. Both behaviour tests failed first.
- **Result:** suite 3667 / 3666 pass / 0 fail / 1 skipped; PG 40/40, also with `PG_POOL_MAX=1`.

**15: the pasting card's editor, printout and list (asked for by Anik, 2026-10-01).** Client only, every change gated on `is_assembly`. Every other card (ordinary, part, gang parent, split gang child) is byte-identical before and after, in the DOM and in printed pixels.
- **Printout** (`printedSpecGroups` in `client/src/lib/cartonParts.js`):
  - no "Sheet & Finish" and no "Printing Specifications";
  - Planning drops Planned Qty, Sheets Required and Press;
  - it keeps Product, Artwork, Ordered Qty, Qty Produced, Cartons to Paste, Planned Date and Delivery;
  - it now fits one page.
- **Editor:**
  - the board band is replaced by the printout's own sentence (`PASTING_NO_BOARD_TEXT`);
  - no Sheets Issued or Press inputs, and no Printing Specifications panel;
  - "Cartons to Paste" is read-only, with a line saying how it is corrected;
  - Planning Engine shows Ordered Qty, Cartons to Paste and Delivery;
  - Product Master keeps Carton Size, Pasting and Die;
  - no Save Changes button, since nothing is editable there.
- **Amend on a pasting card:**
  - quantity labelled "Cartons to Paste";
  - no Sheets Issued field;
  - no Order Qty input; the server's own sentence stands in its place.
- **How a pasting card's count is corrected:** Planning uses Amend, with a reason (audited), once the card is finalised and BEFORE Sort & Paste starts it. Start stamps the figure. The server was not changed.
- **Job Cards list:**
  - the tile reads "5,000 ordered · 5,256 cartons to paste";
  - the export's Sheets Issued column shows "—";
  - the "Sheets issued" total leaves pasting cards out.
- **Result:** suite 3675 / 3674 pass / 0 fail / 1 skipped; PG 40/40. Pins 15 A–G; every gate was mutated on a scratch copy and went red.

**Follow-ups noticed, not built (cosmetic, for Anik to ask for):**
- **Job Cards export:** its "Ordered" column and KPI read a pasting card's planned sets (the page's label for `qty_planned` on every card), while the tile now shows the PO quantity beside the cartons to paste.
- **Split gang child cards:** their `sheets_issued` also holds cartons and is still labelled and summed as sheets. This was already the case before the feature.
- **Sort & Paste at phone width:** the Queue / Completed / Audit tab strip looked squeezed in a simulated 390px browser. This is not from this feature; check on a real phone.
- **Any ordinary card closed at 0 on the Job Cards page:** it still says "FG added to stock". This was already the case before the feature.

**Deliberately not done:**
- the carton product-change refusal stays: its message says what to do;
- null flags in payloads: gzip makes them negligible;
- batching the per-line peek on order save: bom1 is next to Supabase Mumbai;
- the split gang child's job card printing the board box: pre-existing;
- the shortage re-raise raising the full balance and losing the batch: pre-existing, spun off as its own task.

---

## Go-live notes (NOT this session; each needs Anik's say-so in the session that does it)

**Go-live log, 2026-10-01 (Anik: "commit everything push and deploy", in the building session):**
- **Shipped alone.** This feature went out on top of `origin/main` 139f2118, without the sibling branches below. Their merge notes still apply when they land.
- **Step 1 done.** Backup first: `backups/ci-erp-backup-aws-1-ap-south-1-2026-10-01T10-22-00-282Z.json` (59,993 rows, 97 tables). The migration was dry-run inside BEGIN/ROLLBACK with assertions, then applied to `ylbfeptgefzimcqnwphy` as `20261001102258 carton_parts`. Verified: 8 columns on `product_parts`, the three part columns, `is_assembly` NOT NULL default false, the unique index, FK rules c / r / a, both realtime triggers enabled. 795 order lines and 530 job cards, none read as a part line or a pasting card.
- **Read-only A/B on live data before the push.** The deployed code and this commit each answered 90 GET endpoints from the live database (session pooler, read-only guard). All 200. Identical apart from the new fields, a clock field, and one intended change: 34 split gang child cards waiting at Sort & Paste show their planned cartons, where they showed 0 (the Task 14 queue fix).
- **Step 2:** the push of this commit to `main`.
- **Steps 3 and 4 NOT done.** The PO 02545 clean-up and the part masters / parts lists are still Anik's and the plant's. No parts list exists yet, so the feature is dormant.

Everything below was written before go-live. Every step is Anik's call, said out loud in the session that does it. SQL marked **read-only** only reads. Anything that writes is marked **needs Anik's OK**. Checked against the code and the sibling worktrees on 2026-09-30.

### Before the steps: merge the sibling branches and prove the merged tree

Five other branches sit on the same base (`fcfacd6b`), each uncommitted in its own worktree, and four of them touch files this feature changes. Paths come from `git -C "~/Documents/CI ERP FInal/ci-erp" worktree list`.

**Landing order (the decision):**
1. **`fix/order-delete-shade-card-link` lands BEFORE or WITH this feature.** A shade card can be raised against a part line: Sales Pendency and the shade-card form offer each part's own line. `shade_cards.order_line_id` has no delete rule, and this feature's `rollbackLine` (on base `fcfacd6b`) never clears shade cards. So until that branch is in, three things fail with a raw foreign-key error once a part carries a shade card: an order edit that removes the carton, an order delete, and a parts save that drops that part. That branch's `unlinkShadeCardsFromLine` runs in `rollbackLine`'s delete branch, once per part and then for the carton; the card itself stays.
2. **Ship ONE shade branch: `fix/order-delete-shade-card-link`.** It carries the issue-race fix, folded in on Anik's word. `fix/shade-card-issue-detach-race` is a redundant copy: its working tree is byte-identical to it in all 8 files (shasum, 2026-09-30). Never apply both.
3. **Recommended: one merged tree, one push.** `origin/main` + `fix/order-delete-shade-card-link` + `fix/order-delete-card-lock` + `fix/order-row-lock-routes` + this feature, resolved as below and proven together. Those three fixes already stack clean with each other (their notes: full suite 3585 / 0). If `fix/order-row-lock-routes` lands with this feature, `fix/order-delete-card-lock` must land too; "Lock order after the merge" below says why.
4. **`fix/order-delete-lock-order` stays out until its regression is fixed.** Its own note says "REGRESSES, do NOT ship as-is": it deadlocks a dispatch that completes the order.

**In-feature change (being made separately, now).** The parts-list save contains that shade-card foreign-key error for the one order it hits and reports it as a warning, instead of failing the whole save. With `fix/order-delete-shade-card-link` in, the card is detached and that warning should never appear; the change is the backstop.

| Branch | Worktree | Files it shares with this feature | Resolution |
|---|---|---|---|
| `fix/order-delete-card-lock` | `~/Documents/CI ERP FInal/ci-erp-order-delete-card-lock` | `helpers.js`, `routes/orders.js`, `routes/procurement.js`, `gang-lock-order.test.js` | (a) |
| `fix/order-delete-lock-order` | `~/Documents/CI ERP FInal/ci-erp-order-delete-lock` | `routes/orders.js`, `gang-lock-order.test.js` | (b), only after its rework |
| `fix/order-delete-shade-card-link` | `~/Documents/CI ERP FInal/ci-erp-order-delete-shade` | `helpers.js`, `routes/orders.js`, `routes/gangs.js`, `routes/shadecards.js` | (c) |
| `fix/shade-card-issue-detach-race` | `~/Documents/CI ERP FInal/ci-erp-shade-issue-race` | the same four | do not merge: redundant copy of the row above |
| `fix/order-row-lock-routes` | `~/Documents/CI ERP FInal/ci-erp-order-row-lock` | `helpers.js`, `routes/orders.js` | (d) |

**(a) `fix/order-delete-card-lock`.** Three files conflict, a line or two each. `procurement.js` merges clean: its GRN-cover change and ours are in different routes.
- **`rollbackLine`'s line lock (`helpers.js`).** Ours is `line: peek?.has_parts ? 'NO KEY UPDATE' : 'UPDATE'`; theirs is `line: 'NO KEY UPDATE'` for every line. Take theirs, with its comment; it covers ours, since a carton is held NO KEY UPDATE either way.
  - Keep our peek: the part-to-carton redirect still reads `part_of_line_id`. Its `has_parts` then feeds nothing and may go.
  - Keep their `FOR UPDATE NOWAIT` block where it is: directly before `DELETE FROM order_lines`, with nothing awaited in between (their pin 11). A carton in delete mode then upgrades each part just before that part's DELETE, and the carton last, once its parts are gone in the same transaction.
- **The `DELETE /orders/:id` lines lock (`routes/orders.js`)** becomes `SELECT id, gang_run_id, part_of_line_id FROM order_lines WHERE order_id=$1 ORDER BY id FOR NO KEY UPDATE`: our column, their mode and comment.
- **`gang-lock-order.test.js`.**
  - The `rollbackLine` pin (~132) takes their `line: 'NO KEY UPDATE'`.
  - The delete pin (~146) becomes `/SELECT id, gang_run_id, part_of_line_id FROM order_lines WHERE order_id=\$1 ORDER BY id FOR NO KEY UPDATE/`.
  - Their new tests 11 and 12 pass against our code unchanged. Our `rollbackLine` has no other `FROM order_lines WHERE id=$1 FOR …`, and our delete takes no line FOR UPDATE.
- **Our own pins and comments.**
  - `carton-parts-pins.test.js` ~55 becomes `line: 'NO KEY UPDATE'`, and its comment changes to match.
  - `syncPartLines` keeps its first-conversion `FOR UPDATE`, but the reason in its comment changes. "rollbackLine re-enters without an upgrade" stops being the point once `rollbackLine` takes NO KEY UPDATE. The lock stays because raise-pr, plan-save, `POST /requisitions` and PR reassign wait on it and then re-check `hasPartLines`.

**(b) `fix/order-delete-lock-order`. Not as-is.**
- **Merge.** Its `orders.js` hunks sit beside ours and should apply clean; its inserted block ends one unchanged line above our loop change, so check. Its rewritten delete test in `gang-lock-order.test.js` conflicts with our line ~146.
- **Only once its regression is fixed:**
  - keep its order-row shape: order `FOR NO KEY UPDATE`, then the lines, then order `FOR UPDATE NOWAIT`, then the dispatch check under it;
  - keep the lines `FOR NO KEY UPDATE`, never `FOR UPDATE`, NOWAIT or not. The card-lock note warns that "lines FOR UPDATE NOWAIT + retry" brings the card-level deadlock back;
  - keep our `part_of_line_id` column, our `lines.filter(x => !x.part_of_line_id)` loop and our audit count;
  - its pin's lines string becomes `SELECT id, gang_run_id, part_of_line_id FROM order_lines WHERE order_id=$1 ORDER BY id FOR NO KEY UPDATE`.
- The earlier note here said "keep ITS lock sequence (… lines `FOR UPDATE` …)" unconditionally. That was wrong on both counts: the branch regresses, and its lines must not stay `FOR UPDATE`.

**(c) `fix/order-delete-shade-card-link`.**
- **The one textual conflict** is the `import { … } from '../helpers.js'` line in `routes/orders.js`. Keep every name: theirs are `unlinkShadeCardsFromOrder, unlinkShadeCardsFromLine`, ours are `partLinesOf, hasPartLines`, and row-lock adds `retryWhileLinesBusy`.
- **Everything else lands in different places:**
  - in `rollbackLine`, their calls sit in step 2 and the delete tail; ours sit at its top, its lock, after the blockers, and in the rollback-mode zeros;
  - in PUT, their unlink sits in the ordinary-line branch of the removal loop; ours is the carton branch above it;
  - `gangs.js` and `shadecards.js`: they change different routes from ours.
- **The merged tail** of `rollbackLine`'s delete branch reads: FG detach → `unlinkShadeCardsFromLine` → audit → (card-lock) `FOR UPDATE NOWAIT` → DELETE.
- **The delete preview** also lists a shade card on a part line, because our preview keeps part lines in `lineIds`.

**(d) `fix/order-row-lock-routes`.** `helpers.js` merges clean: their `retryWhileLinesBusy` sits after `lockLineGangFirst`, and ours are elsewhere. `routes/orders.js` conflicts in three places: the import line, PUT's transaction opening and order lock, and PUT's `existing` read.

Resolve PUT to this order, in each attempt:
1. `warnings.length = 0;` (theirs). A retried attempt starts over, and our sync warnings go into the same array.
2. `pg_advisory_xact_lock_shared(hashtext('product_parts'))` (ours). It stays the FIRST lock; a retry rolls it back and takes it first again.
3. The order row `FOR NO KEY UPDATE` (theirs), then the header UPDATE.
4. EVERY line of the order, part lines included, `ORDER BY id FOR NO KEY UPDATE NOWAIT`. Then split the result: `existing` holds the non-part lines, so our removal loop never sees a part; `ownParts` holds the part lines.
   - Do not add our `part_of_line_id IS NULL` to the locking query. The part lines that `syncPartLines` and `rollbackLine` write later would then be locked by waiting, inside a transaction that holds the order row.
5. The dropped ORDINARY lines `FOR UPDATE NOWAIT` (theirs). Compute them from the non-part lines, and leave out a dropped carton.
   - Their `existing.filter(x => !listed.has(x.id))` over ALL lines would take every part line FOR UPDATE, because the edit form never sends one.
   - `rollbackLine` unwinds a dropped carton and its parts holding NO KEY UPDATE, and with card-lock upgrades each NOWAIT at its own DELETE. Taking a part FOR UPDATE up front is the card-level deadlock card-lock removed.
6. The rest as built: line updates and inserts, carton removal through `rollbackLine`, then `syncPartLines` per kept line.

The other routes:
- **Order cancel and `status → cancelled`.** Move our `cartonCancelBlock` below their `… ORDER BY id FOR NO KEY UPDATE NOWAIT` on the open lines. The part lines are among those lines, so the statuses it reads are then locked. Where it sits today, it reads them unlocked.
- **`complete-lines`** does not conflict: ours only adds `part_of_line_id IS NULL` to the roll-up count.
- **Our line cancel (`/order-lines/:id/cancel`)** is untouched by row-lock. It locks the line, and a carton's parts, NO KEY UPDATE before `setLineStatus` reads them. That also closes the line-cancel race row-lock's note lists as "found in passing".

Pins:
- Their `order-row-lock.test.js` passes on the merged text. It cannot see inside `syncPartLines` or `rollbackLine`, so green proves nothing about the waits below.
- In ours, the PUT anchor of the (a2) "lock first" pin moves from `'FOR UPDATE'` to `'FROM orders WHERE id=$1 FOR'`. Otherwise it checks a later statement and passes anyway.
- The Task 7 pin on `existing` follows the new query.

**Lock order after the merge:**
- **`DELETE /orders/:id`.**
  - The order: gangs `FOR NO KEY UPDATE` in id order → the order row `FOR UPDATE` → every line, parts included, `ORDER BY id FOR NO KEY UPDATE` → `rollbackLine` for each non-part line, in id order → FG detach → shade order detach → DELETE the order.
  - Inside `rollbackLine`, a carton unwinds each part first, in ascending id: reserved FG → card stages → shade custody detach → card → holds, PR, mix → FG detach → shade line detach → `FOR UPDATE NOWAIT` → DELETE. Then it unwinds itself the same way.
  - Deadlock-free as far as reading goes. Carton first, then its parts in ascending id, is the order every carton path takes: line cancel, `rollbackLine`, the pasting-card join. A part's id is always above its carton's, so the id-order line lock agrees with it.
  - The known exception stays: a force delete racing a die-cut on the same carton (v1 limits).
- **`PUT /orders/:id`.** Parts lock (shared) → order `FOR NO KEY UPDATE` → all lines NOWAIT → dropped ordinary lines `FOR UPDATE NOWAIT` → writes. Not provable by reading. Two locks taken inside called functions can still WAIT for a line while PUT holds the order row, which is exactly what row-lock forbids:
  1. **`syncPartLines`' first-conversion `FOR UPDATE`** on a line becoming a carton. It upgrades step 4's NO KEY UPDATE, so it waits for any share-lock on that line: a raise-pr, a shade card, a dispatch's challan line.
     - The lock is load-bearing: the plan and PR doors wait on it and then re-check.
     - Resolve by taking any kept line that this save will convert (its new product has parts, and it has no part lines yet) `FOR UPDATE NOWAIT` in the same up-front statement as the dropped lines. The `product_parts` read is stable under the shared parts lock. Otherwise, prove the wait harmless.
  2. **Without card-lock, `rollbackLine` takes each part of a removed carton `FOR UPDATE`**, the same kind of wait. With card-lock it is NO KEY UPDATE, plus NOWAIT at the DELETE. Hence card-lock with row-lock.
  - Also: removing a carton whose part has an unstarted job card now waits on that card inside PUT. That is the card→line exposure card-lock's note already lists as open for `DELETE /orders` (a Print Planning drag, an `order_qty` amend, a plates issue). Pre-existing family, not new in kind.
- **Order cancel, `status → cancelled`.** Order `FOR NO KEY UPDATE` → open lines, parts included, NOWAIT → `cartonCancelBlock` → `setLineStatus` for each → order UPDATE. Nothing new waits, so row-lock's proof carries over.
- **Line cancel.** The line `FOR NO KEY UPDATE` → its part lines `ORDER BY id FOR NO KEY UPDATE` → the guard → `setLineStatus`. It holds no order row, so row-lock's rule does not bind it.

**Two Task 13a notes for whoever merges `fix/order-row-lock-routes`:**
- `syncPartLines` now locks a carton's part lines only when it is about to WRITE one, and then only the parts its unlocked read found still in planning (unlocked read → lock those in id order → re-read → decide again; a part past planning keeps its first reading). Lock-order tests (vii) and (viii). An always-on lock deadlocked every edit of the order against a push or plan save (lock-order test (vii), 40P01), because a part written twice KEY SHAREs the order while PUT holds it. An order edit that DOES change a carton's parts can still deadlock with a push or plan save on the same part, exactly as the old code did. Row-lock's NOWAIT + retry is the cure, so after the merge that part lock inside PUT /orders must follow row-lock's NOWAIT + retry rule, and row-lock's `dropped` list must never take part lines FOR UPDATE.
- Task 13a loosened two OTHER features' pins that listed the plan-save response fields exactly (the response now carries `part_qty_kept`): `keep-parent-off-impossible-master.test.js` (~172) and `master-parent-cannot-stay.test.js` (~170). If a sibling touches either pin, keep the "at least these fields" form.

**Re-run on the merged tree, before step 2** (from `server/`):
- `node --test src/*.test.js 2>&1 | tail -8`. Never `node --test src/`. The 2 known `section-lean-rows` fails come from the space in `CI ERP FInal`.
- `CARTON_PARTS_PG=1 node --test src/carton-parts-lock-order-pg.test.js src/carton-parts-flow-pg.test.js`
- `ROLLBACK_LINE_LOCK_PG=1 node --test src/rollback-line-lock-pg.test.js`
- `ORDER_ROW_LOCK_PG=1 node --test src/order-row-lock-pg.test.js`
- `ORDER_DELETE_SHADE_PG=1 node --test src/order-delete-shade-card-pg.test.js`
- `SHADE_CARD_LOCK_PG=1 node --test src/shade-card-lock-order-pg.test.js`
- `GANG_LOCK_PG=1 node --test src/gang-lock-order-pg.test.js`
- `ORDER_DELETE_LOCK_PG=1 node --test src/order-delete-lock-pg.test.js`, only if the reworked delete-lock is in.
- Add three cases to `carton-parts-lock-order-pg.test.js`, each red first ([[ci-erp-guard-must-fail-first]]):
  - an order edit converting a line, against a raise-pr on it;
  - an order edit removing a carton, against a push on one of its parts;
  - an order cancel, against a push on a part.

### The steps, in this order

**1. Prod schema, then prove it.**
- Apply `20260929120000_carton_parts.sql` as a named migration on `ylbfeptgefzimcqnwphy` **before** any code deploys. `LINE_VIEW` reads `ol.part_of_line_id`, so the new code 500s on a database without the column. Check prod's schema first ([[ci-erp-check-prod-schema-before-deploy]]).
- Apply it off-shift. On the 1 s lock timeout the whole file rolls back; re-run it.
- `db:check` compares columns only, so also prove the rest by query on prod. All of these are **read-only**; paste each and compare with its "expect" line.

```sql
-- 1a. Foreign keys. Expect 3 rows:
--   order_lines   part_of_line_id  → order_lines  a   (no action: a part leaves only through rollbackLine)
--   product_parts outer_product_id → products     c   (cascade)
--   product_parts part_product_id  → products     r   (restrict)
select c.conrelid::regclass as tbl, a.attname as col, c.confrelid::regclass as refs, c.confdeltype
  from pg_constraint c
  join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
 where c.contype = 'f'
   and (c.conrelid = 'public.product_parts'::regclass
        or (c.conrelid = 'public.order_lines'::regclass and a.attname = 'part_of_line_id'))
 order by c.conrelid::regclass::text, a.attname;

-- 1b. New columns. Expect 4 rows:
--   job_cards   is_assembly      boolean  NO   false
--   order_lines part_label       text     YES  (null)
--   order_lines part_of_line_id  integer  YES  (null)
--   order_lines part_per_carton  integer  YES  (null)
select table_name, column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_schema = 'public'
   and ((table_name = 'job_cards' and column_name = 'is_assembly')
     or (table_name = 'order_lines' and column_name in ('part_of_line_id', 'part_label', 'part_per_carton')))
 order by table_name, column_name;

-- 1c. One line per part per carton. Expect 1 row: indisunique t, indisvalid t, and
--   CREATE UNIQUE INDEX order_lines_one_line_per_part ON public.order_lines
--   USING btree (part_of_line_id, product_id) WHERE (part_of_line_id IS NOT NULL)
select i.indexrelid::regclass as index, i.indisunique, i.indisvalid, pg_get_indexdef(i.indexrelid) as def
  from pg_index i
 where i.indexrelid = to_regclass('public.order_lines_one_line_per_part');

-- 1d. Realtime triggers ([[ci-erp-new-table-needs-realtime-ping]]). Expect exactly 1 row, product_parts:
--   its row trigger and its truncate trigger together cover insert, update, delete and truncate
--   (tgtype bits 4 + 8 + 16 + 32 = 60). Drop the relname filter to list every covered table.
select c.relname from pg_trigger t join pg_class c on c.oid=t.tgrelid
 where t.tgfoid='public.ci_erp_realtime_ping()'::regprocedure and t.tgenabled in ('O','A') and not t.tgisinternal
   and c.relname = 'product_parts'
 group by c.relname having (bit_or(t.tgtype::int) & 60) = 60;

-- 1e. The heartbeat names it. Expect inserted_at after the migration, tracks_product_parts = true,
--   and tables_tracked one more than in the last heartbeat before the migration.
select m.inserted_at,
       (m.payload -> 'tracked') ? 'product_parts' as tracks_product_parts,
       jsonb_array_length(m.payload -> 'tracked') as tables_tracked
  from realtime.messages m
 where m.topic = 'ci-erp:db-changes' and m.event = 'db-heartbeat'
 order by m.inserted_at desc
 limit 1;
```
- **How the heartbeat reports its tables (for 1e).** `public.ci_erp_realtime_heartbeat()` comes from migration `20260917024744`. It builds its `tracked` list with the same trigger-coverage query as 1d and sends it through `realtime.send`, which writes to `realtime.messages`. It rides on traffic:
  - each server instance asks at most every 50 s, after a response (`server/src/realtime-heartbeat.js`);
  - the function itself sends at most one heartbeat every 45 s;
  - so open any screen after the migration and re-run 1e within about a minute.
  - Browser check: in an open motionci.in tab's console, `__ciResponseCacheStats().announced` goes up by one. It holds the count only, not the names.
- **Expect Supabase's security advisor to flag `product_parts` as "RLS disabled".** It is harmless: the Data API has been off since 2026-09-17 ([[ci-erp-supabase-data-api-off]]), so no public client reaches any table; the app talks to Postgres directly. The Fluence tables show the same flag. Leave it.

**2. Deploy the merged tree, then smoke-test.**
- Deploy only with Anik's word in that session: pushing `main` deploys motionci.in.
- **Bundle: no action needed.** The new server modules are static imports, so @vercel/nft traces them into `api/index.js`. `vercel.json` leaves `supabase/**`, every migration file, out of the bundle. That is fine: `api/index.js` only calls `connect()`, and `init()`, the only code that reads migration files, never runs on Vercel.
- **Smoke list.** Open each of these once and check it loads with no red toast and no 500 in the Vercel logs:
  - Planning
  - one order's detail
  - Sales Pendency
  - Status Sheet
  - Track
  - Job Cards
  - Sort & Paste
  - Product Master → an outer carton → **Made in parts**
- **Then ask every floor tablet to reload.** An old bundle does four things wrong:
  - it still offers part products in the PO picker;
  - it does not show the "rolls back the whole carton" wording on a part row;
  - it lets the qty box be edited on a part row. The server keeps the part's own qty (audited `part_qty_kept`), so nothing breaks, but the box misleads;
  - its Status Sheet shows **Print Status "Not started"** for a carton made in parts. The new bundle reads the server's `print_state`.

**3. PO 02545 clean-up (found 2026-09-29), before step 4.**
- **The problem.** Line 950 "PAT 1" and line 1017 "PAT 2" are both SW-715 × 11,500. That is the carton entered twice, one line per part, so pendency shows 23,000 cartons. Line 952 is SW-712 × 1,500.
- **Why before step 4.** While SW-715 has no parts, 950 and 1017 are ordinary lines. Saving SW-715's parts converts every open SW-715 line, so 1017 would gain part lines of its own, and removing it would then go through the carton's rollback.

Re-check on the day (**read-only**):
```sql
-- 3a. Every line of the order holding line 950, as it stands today. Confirm po_number reads 02545.
--     Any line added since 09-29 shows here too.
select o.po_number, ol.id, p.code, ol.qty, ol.status, ol.line_remark, ol.gang_run_id,
       ol.sheets_required, ol.parent_sheets_required, ol.dispatched_qty, ol.fg_consumed_qty,
       (select count(*) from requisitions r      where r.order_line_id = ol.id)                                     as prs,
       (select count(*) from requisitions r      where r.order_line_id = ol.id and r.purchase_order_id is not null) as prs_on_a_po,
       (select count(*) from board_allocations a where a.order_line_id = ol.id and a.status = 'active')            as active_holds,
       (select count(*) from job_board_mix m     where m.order_line_id = ol.id)                                     as mix_rows,
       (select count(*) from shade_cards s       where s.order_line_id = ol.id)                                     as shade_cards,
       (select count(*) from job_cards j         where j.order_line_id = ol.id)                                     as job_cards,
       (select count(*) from fg_consumptions f   where f.order_line_id = ol.id)                                     as fg_reserved,
       (select count(*) from fg_lots x        where x.order_line_id = ol.id)
     + (select count(*) from fg_movements x   where x.order_line_id = ol.id)
     + (select count(*) from dispatch_lines x where x.order_line_id = ol.id)
     + (select count(*) from coas x           where x.order_line_id = ol.id)                                        as other_rows
  from order_lines ol
  join orders o   on o.id = ol.order_id
  join products p on p.id = ol.product_id
 where ol.order_id = (select order_id from order_lines where id = 950)
 order by ol.id;

-- 3b. What happened to the three lines since 09-29.
select created_at, entity_id as line, action, detail, user_name
  from audit_log
 where entity = 'order_line' and entity_id in (950, 952, 1017) and created_at >= '2026-09-29'
 order by created_at;

-- 3c. Line 950's PRs, and the purchase order each one is on.
select r.pr_number, r.status, r.qty, m.name as board, po.po_number, po.status as po_status
  from requisitions r
  join materials m on m.id = r.material_id
  left join purchase_orders po on po.id = r.purchase_order_id
 where r.order_line_id = 950
 order by r.id;
```
Then act on what 3a shows:
- **Line 1017 goes.**
  - **3a shows nothing attached** (every count 0, no gang, still pending): the PO person removes it in **Orders → Edit**. That is an ordinary audited edit.
  - **Anything attached** (a PR, a hold, a board mix, a shade card, a job card, FG reserved or other FG rows): a planner removes it in **Planning** → line 1017's row menu → **Delete entirely** → **Delete Everywhere**. That door is `rollbackLine`: it releases reserved FG, deletes an unstarted job card, releases holds on record, deletes a PR that is not yet on a purchase order, and clears the mix.
  - **Why not Orders → Edit then.** Checked in `routes/orders.js`: an edit removes an ordinary line with a bare `DELETE FROM order_lines`. It only refuses a line with a job card or a dispatch ("Cannot remove lines that already have dispatch or job card activity").
    - A PR, reserved FG and other FG rows point at the line through foreign keys with no delete rule, so the edit fails with a raw foreign-key error and rolls back whole. So does a shade card, unless `fix/order-delete-shade-card-link` is in.
    - Holds and mix rows cascade instead: the edit "works" but deletes them with no release on record.
  - **Planning refuses too** in three cases:
    - a PR already on a purchase order: "cancel the purchase order first";
    - a started job-card stage: "send it back … first";
    - a shade card: a raw foreign-key error, unless `fix/order-delete-shade-card-link` is in. With it, the card is detached and stays.

    Clear those first.
- **Line 950 stays.**
  - Clear its "PAT 1" batch in Orders → Edit. The remark is the batch field, and step 4 would copy it onto both part lines.
  - Then read 3c. No PR, or a PR not yet on a purchase order, is fine: step 4 converts 950, and the conversion's audited rollback deletes such a PR.
  - **A PR already on a purchase order** makes step 4 answer `PO 02545 (11,500): This line stays one carton this time — Board already ordered against this line’s requisition — cancel the purchase order first`. Line 950 would then plan as one carton on SW-715's own board.
    - Settle that PO in Procurement before step 4. A PR that is on a PO cannot be re-pointed.
    - Then save SW-715's parts again. An unchanged list still re-syncs, so 950 converts then.
- **Line 952** (SW-712 × 1,500) converts when SW-712's parts are saved, if it is still pending or planned, in no gang, and has no PR on a purchase order. Otherwise step 4 warns and it runs as one carton this time; decide before step 4.

**Alias check (read-only)**, before the next VOGEAB PO is imported:
```sql
-- 3d. Aliases the PO import has learned for the three cartons.
select a.id, p.code, c.name as customer, a.alias_norm, a.created_at,
       a.alias_norm ~ '\m(PAT|PART) ?[12]\M' as names_a_part
  from product_aliases a
  join products p  on p.id = a.product_id
  join customers c on c.id = a.customer_id
 where p.code in ('SW-712', 'SW-715', 'SW-716')
 order by p.code, a.created_at;
```
- **Why it matters.** The import wizard learns an alias from every row a person confirms (`POST /orders/import/alias`, keyed on the row's normalised text), and `matchLine` tries aliases first, as an exact match. If PO 02545's "PAT 1" and "PAT 2" rows were confirmed as SW-715, every future PO with those rows auto-matches both to the carton, which is the double entry again.
- **How to remove them.** The app has no alias screen: the wizard only adds aliases, and no route lists or deletes one. So it takes a statement, which **needs Anik's OK**. Use only the ids the SELECT flagged:
```sql
begin;
delete from product_aliases where id in (/* ids from 3d */) returning id, customer_id, alias_norm, product_id;
commit;   -- after checking the returned rows; otherwise: rollback;
```

**4. Part masters and parts lists (Anik's team).**
- Naming rules for part masters. The PO import finds codes as whole words and tries cartons first.
  - Keep the code the Product Master assigns each part (the next SW- number). Never retype it as SW-715-P1, SW-715/1 or "SW-715 P1".
  - Put "Part 1" / "Part 2" in the NAME.
  - Leave a part's Party Item Code blank unless the customer orders that piece under its own SKU. Never copy or extend the carton's item code onto a part.
  - If the customer's own piece SKUs do extend the carton's, tell the developers first: the matcher would need to prefer the longest matching code.
- For **SW-712** (GM1 outer), **SW-715** and **SW-716** (GM2 outers):
  - create one Product Master row per part, each with its **own** board, sheet size, ups, die and plate;
  - then open the outer → **Made in parts** → pick them → Save.
- Nobody may guess board sizes; they come from the plant. SW-712 and SW-716 have **no board on file** today, and SW-715 shows `12×18` with 2 ups.
- Before each save, see which open lines it will touch (**read-only**):
```sql
-- 4a. Open lines of the three cartons on any PO. already_in_parts = true means it converted earlier.
select p.code, o.po_number, ol.id, ol.qty, ol.status, ol.line_remark, ol.gang_run_id,
       exists (select 1 from requisitions r where r.order_line_id = ol.id and r.purchase_order_id is not null) as pr_on_a_po,
       exists (select 1 from order_lines x where x.part_of_line_id = ol.id) as already_in_parts
  from order_lines ol
  join orders o   on o.id = ol.order_id
  join products p on p.id = ol.product_id
 where p.code in ('SW-712', 'SW-715', 'SW-716')
   and ol.part_of_line_id is null
   and ol.status not in ('dispatched', 'cancelled')
 order by p.code, o.po_number, ol.id;
```
- **Read every warning the save returns.** They show beside Save and in the toast. A save never fails for one blocked line; it names each line as `PO <number> (<qty> · <batch>): …`, and **a warned line did NOT convert**:
  - `This line stays one carton this time — …`: the line has board already on a purchase order, or something already dispatched. Fix that, then save again; an unchanged list still re-syncs.
  - `This line is in a gang — take it out of the gang to run it in parts`.
  - `already ready` / `already in production — it runs as one carton this time`.
  - `The parts list stays as it was on this order — …`: a part could not be removed.
  - A contained foreign-key error for one order (the in-feature change above). With `fix/order-delete-shade-card-link` in, a shade card on a part no longer causes one.

### Rollback plan

- **Before any parts list is saved: revert the code, keep the schema.** Redeploy the previous build. The schema is additive: a table nothing old reads, nullable columns, and a `false` default that old code never looks at. Leave it. No data needs undoing.
- **After a parts list is saved, old code misreads what the feature wrote** (checked against `fcfacd6b`):
  - it treats a part line as an ordinary line: Planning plans it, a push gives it the full route (`routingFor`, cutting through pasting), and its last stage credits FG with the PART;
  - it reads the carton's `0 / 0 / 0` as a saved plan (`plan_draft`), so the carton shows as a draft in Planning and the Artwork queue and can be planned and pushed on its own board;
  - an open pasting card's sorting start would issue the outer's board, because the old start route treats it as a card's first stage;
  - it cannot remove a carton line, or delete its order, while part lines point at it: the `part_of_line_id` key refuses with a raw error.
- **So clear the parts lists first, then revert.** Product Master → each outer → Made in parts → remove every part → Save.
  - **What the save does** (`syncPartLines`, `carton-parts-db.js`): it runs on each open carton line. Each part line leaves through `rollbackLine`, with its holds, PRs and card undone on record. Once none is left, the un-made reset sets the carton's sheets back to NULL (`no_longer_in_parts` in its history), and it is an ordinary line again.
  - **It works only while every part of that carton is still pending or planned.** Past that, the list is frozen for the order ("already under way as Part 1 + Part 2 …") and nothing is removed.
  - **Read the warnings.** `The parts list stays as it was on this order — …` means that carton was NOT cleared:
    - a part's PR is on a purchase order: cancel it first;
    - a part has a started stage: roll the carton back in Planning, after sending those stages back.
  - **A shade card on a part line** fails the save without `fix/order-delete-shade-card-link`. With the in-feature change, it warns for that order instead.
- **Fix forward instead when:**
  - any part is die-cut;
  - any pasting card exists;
  - any cancelled or pasted carton still has part lines. The clear only touches cartons that are pending or planned, so those part lines stay, and old code can neither delete their orders nor edit the carton away.

### Deliberate v1 limits, for Anik to accept or change

- **NEW, for sign-off: once a part is die-cut, its carton has no in-app exit until the pasting card closes.** Checked against:
  - `partsChangeBlock` (`carton-parts.js`);
  - `rollbackLine` with `splitGangReverseBlock` (`helpers.js`), and `stageReverseMoves` for Send back;
  - the line and order cancel routes (`routes/orders.js`);
  - close short, `POST /order-lines/:id/shortage` (`dispatch.js`).

  | When | The carton made in parts | An ordinary line at the same point |
  |---|---|---|
  | Every part pending or planned | Cancel ✓ (its parts cancel with it) · roll back ✓ · remove or delete ✓ | Same |
  | A part ready or carded, no stage started | Cancel ✗ ("Part 1 of this carton is already cleared for its job card — roll the carton back in Planning first, then cancel it") · roll back ✓ (the whole carton; unstarted part cards are deleted) | Cancel ✗ too: a line cancels only from pending or planned · roll back ✓ |
  | A part stage started, none die-cut | Cancel ✗ · roll back ✗ until that part's stages are sent back, then ✓ | Same |
  | **A part die-cut, pasting card not made yet** | Cancel ✗ ("… is already die-cut — the carton can no longer be cancelled"; since Task 13a it no longer offers a rollback that would itself be refused) · roll back, remove, plain order delete ✗ ("… is a finished part") · Send back or adjust of the die-cut ✗ · close short ✗ (the carton line is still pending; close short needs it produced with its card closed) | Die cutting can be sent back and the line rolled back. Or the card runs on through sorting and pasting and closes short |
  | Pasting card made | Cancel ✗ · roll back ✗ (Send back at Sort & Paste redoes sorting or pasting) · close short ✓ once the pasting card closes | Close short once its card closes: same |

  - **Ways out, in the bold row:**
    - die-cut the remaining parts. The pasting card then appears and can close short at Sort & Paste, and Dispatch closes the carton short or re-raises the balance. Whether a pasting card for 0 cartons closes is Task 12 Step 3b's question;
    - force-delete the WHOLE order, which unwinds every card;
    - an admin fix.
  - **What is new against an ordinary line:** a part's die-cut is final, and the carton cannot close until EVERY part is die-cut. So one part that cannot be made strands the parts already cut. Accept, or ask for a follow-up, such as "close the carton short with the parts made so far".
- **A part cannot be ganged or run in a Combined Run.** A gang child would credit FG with the part itself. If the plant wants to gang Part 2 (12×18) with other cartons, that is a follow-up: split the gang child at die cutting into a part pile instead of an FG receipt.
- **Pasting starts when BOTH parts are die-cut.** This matches how a gang hands over to its children.
- **Spare pieces** (the larger part's surplus) are recorded on the pasting card's audit line only. They are not stocked.
- **A carton made in parts cannot be filled from FG stock.** Complete from Stock and consume-FG live on Planning rows, and the carton is hidden there. Enabling it later means `fulfil-from-stock` must take the parts out through `rollbackLine`.
- **A carton line in an unexpected state refuses the last part's die-cut save** with a message naming the carton and PO. The guards make that state unreachable (carton cancel, fill-from-stock and gang moves are refused), so a loud refusal was chosen over a silently stranded carton.
- **Machine load counts part pieces per press.** Each part card is a real press job, and the pasting card has no machine, so nothing is double-counted.
- **A finished (die-cut) part cannot be sent back or reopened.** The refusal says: "If its die-cut count is wrong, ask an admin to correct it." The practical correction is on the pasting card: once it is finalised and before Sort & Paste starts it, Planning amends its Cartons to Paste (Amend, reason required, audited).
- **Part names and the strength alarm.** Since Task 13a, Print Planning's strength mix-up alarm never compares two parts of the SAME carton (siblings in `product_parts`), so "… PART 1" / "… PART 2" never trip it. Parts of DIFFERENT cartons (GM1 vs GM2) are still compared as before. A part the master has since dropped is compared again.
- **Print Planning danger menu (pre-existing, left off):** it never renders for any card, because the `/print-planning` query has no `order_line_id`, and that has been true since before this feature. The part fields now ride on the card, so if the menu is ever switched on, a part shows the whole-carton rollback text and no Delete. Switching it on enables Rollback/Delete for every Print Planning card, which is Anik's call.
- **Import nit (deferred):** if a carton's master rate is revised earlier in the SAME import session, a part row that later picks that carton seeds the old rate (`p.rate`, not `rateOverrides[p.id]`), while its chip names the new one. Rare.
- **Known, not new: a forced reverse-to-Planning racing a final-stage close deadlocks.** Postgres aborts one; the user retries. It happens on ordinary cards today, and on the last part's die-cut too.
- **Known, rare: a lock-order deadlock.** A force order-delete running at the very same moment as a die-cut on the same carton can deadlock. Postgres aborts one side and the user retries. The fix, if it ever shows: lock the carton line first in the complete handler.
