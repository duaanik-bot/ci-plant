# Live Floor Section Bands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild Live Floor as one stack of section bands — machines nested inside their section, three jobs each, with hold / extra-sheet / reorder control on the board itself.

**Architecture:** All ordering and splitting logic lands in a new pure module `server/src/floor-order.js` with a twin test, following the codebase's existing `board-math.js` / `stage-runs.js` pattern. The routes call it; the four floor boards then sort through one comparator and cannot drift. A new nullable `job_stages.floor_pos` holds the floor's own order and is never read or written by Print Planning. The client splits `Floor.jsx` into three focused components under `client/src/components/floor/`.

**Tech Stack:** Node + Express + Postgres (`pg`), React + Vite + Tailwind, `node:test` + `node:assert/strict`, migrations as numbered SQL under `supabase/migrations/`.

**Spec:** `docs/superpowers/specs/2026-07-28-live-floor-section-bands-design.md`

---

## Before you start

Read the spec. Then read these three files — the plan edits all of them and assumes you know their shape:

- `server/src/routes/floor.js` (875 lines) — the four boards: `/floor`, `/floor/machines`, `/floor/:section`, `/floor/sort-paste`
- `client/src/pages/Floor.jsx` (574 lines) — the page being replaced
- `client/src/sections.js` — `SECTION_META`, `SORT_PASTE_META`, `FLOOR_NAV`, `HOLD_REASONS`

**The working tree is shared.** Another Claude session has an uncommitted notifications/approvals wave in it (`server/src/approvals.js`, `server/src/routes/notifications.js`, `supabase/migrations/0007_notifications_approvals.sql`, `supabase/migrations/0008_chat_messenger.sql`, plus modifications to `db.js`, `auth.js`, `extrasheets.js`, `helpers.js`, `AppLayout.jsx`, `ExtraSheets.jsx`, `Masters.jsx`, `Planning.jsx`, `app.js`, `0001_baseline_schema.sql`). That session is still working — it took `0008` mid-flight, which is why this plan uses `0009`. Re-check `ls supabase/migrations/` before creating yours. Every commit in this plan names its files explicitly — `git add <exact paths>`, never `git add -A` or `git add .`. Task 2 has a specific hazard around the generated baseline file; read it there.

**Verification.** `npm run verify` from the repo root runs `node scripts/build-baseline.mjs --check && npm test -w server && npm run build -w client`. Server tests alone: `npm test -w server` (which is `node --test src/*.test.js`).

## File Structure

**Create:**
- `server/src/floor-order.js` — pure ordering + splitting logic. No DB, no Express. Four exports: `boardSort`, `normalise`, `moveWithin`, `splitByMachine`.
- `server/src/floor-order.test.js` — its twin test.
- `supabase/migrations/0009_floor_queue_order.sql` — the `floor_pos` column for an existing database.
- `client/src/components/floor/JobRow.jsx` — one job line with its control cluster.
- `client/src/components/floor/MachineBlock.jsx` — one machine: header row, `⋯` menu, its pinned jobs.
- `client/src/components/floor/SectionBand.jsx` — one section: clear row or full band.

**Modify:**
- `server/src/db.js:586` — add the `floor_pos` ALTER alongside the other `job_stages` ALTERs.
- `server/src/routes/floor.js` — `floor_pos` into four SELECTs and four sorts; `splitByMachine` into `/floor` and `/floor/machines`; new `POST /floor/queue/move`.
- `client/src/pages/Floor.jsx` — reduced to page shell, data load and modals.

**Delete (inside `Floor.jsx`):** `JobChip`, `MachineJobRow`, `MachineCard` — replaced by the three new components.

---

### Task 1: Pure ordering module

The whole reorder is decided here, with no database in the loop. `splitByMachine` also fixes the duplicate-`shared` bug from the spec, so it gets a regression test.

**Files:**
- Create: `server/src/floor-order.js`
- Test: `server/src/floor-order.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/src/floor-order.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boardSort, normalise, moveWithin, splitByMachine } from './floor-order.js';

const job = (o) => ({ stage_id: o.id, job_card_id: o.id, stage: 'die_cutting',
  machine_id: null, floor_pos: null, queue_pos: null, delivery_date: null, ...o });

test('boardSort puts the floor order ahead of Print Planning queue_pos', () => {
  const a = job({ id: 1, floor_pos: 2, queue_pos: 1 });
  const b = job({ id: 2, floor_pos: 1, queue_pos: 9 });
  assert.deepEqual([a, b].sort(boardSort).map(j => j.stage_id), [2, 1]);
});

test('boardSort falls back to queue_pos, then delivery date, then job card id', () => {
  const a = job({ id: 1, queue_pos: 2 });
  const b = job({ id: 2, queue_pos: 1 });
  assert.deepEqual([a, b].sort(boardSort).map(j => j.stage_id), [2, 1]);

  const c = job({ id: 3, delivery_date: '2026-08-01' });
  const d = job({ id: 4, delivery_date: '2026-07-30' });
  assert.deepEqual([c, d].sort(boardSort).map(j => j.stage_id), [4, 3]);

  const e = job({ id: 6 });
  const f = job({ id: 5 });
  assert.deepEqual([e, f].sort(boardSort).map(j => j.stage_id), [5, 6]);
});

test('a job with no floor_pos sorts after one that has it', () => {
  const a = job({ id: 1 });
  const b = job({ id: 2, floor_pos: 7 });
  assert.deepEqual([a, b].sort(boardSort).map(j => j.stage_id), [2, 1]);
});

test('normalise numbers a lane 1..N in board order', () => {
  const lane = [job({ id: 1, queue_pos: 3 }), job({ id: 2, queue_pos: 1 }), job({ id: 3, queue_pos: 2 })];
  assert.deepEqual(normalise(lane).map(j => [j.stage_id, j.floor_pos]), [[2, 1], [3, 2], [1, 3]]);
});

test('normalise does not mutate its input', () => {
  const lane = [job({ id: 1 })];
  normalise(lane);
  assert.equal(lane[0].floor_pos, null);
});

test('moveWithin lifts a job one place up its lane', () => {
  const lane = [job({ id: 1, floor_pos: 1 }), job({ id: 2, floor_pos: 2 }), job({ id: 3, floor_pos: 3 })];
  assert.deepEqual(moveWithin(lane, 3, 'up'), [{ stage_id: 3, floor_pos: 2 }, { stage_id: 2, floor_pos: 3 }]);
});

test('moveWithin pushes a job one place down its lane', () => {
  const lane = [job({ id: 1, floor_pos: 1 }), job({ id: 2, floor_pos: 2 })];
  assert.deepEqual(moveWithin(lane, 1, 'down'), [{ stage_id: 1, floor_pos: 2 }, { stage_id: 2, floor_pos: 1 }]);
});

test('the first move on an all-null lane writes every row, not two nulls', () => {
  const lane = [job({ id: 1, queue_pos: 1 }), job({ id: 2, queue_pos: 2 }), job({ id: 3, queue_pos: 3 })];
  const writes = moveWithin(lane, 3, 'up');
  assert.deepEqual(writes, [{ stage_id: 1, floor_pos: 1 }, { stage_id: 3, floor_pos: 2 }, { stage_id: 2, floor_pos: 3 }]);
});

test('moving off either end is a no-op, not an error', () => {
  const lane = [job({ id: 1, floor_pos: 1 }), job({ id: 2, floor_pos: 2 })];
  assert.deepEqual(moveWithin(lane, 1, 'up'), []);
  assert.deepEqual(moveWithin(lane, 2, 'down'), []);
});

test('moving a job that is not in the lane is a no-op', () => {
  assert.deepEqual(moveWithin([job({ id: 1, floor_pos: 1 })], 99, 'up'), []);
});

test('splitByMachine gives each machine only its own pinned jobs', () => {
  const jobs = [job({ id: 1, machine_id: 10 }), job({ id: 2, machine_id: 11 })];
  const { pinned } = splitByMachine(jobs, [10, 11]);
  assert.deepEqual(pinned.get(10).map(j => j.stage_id), [1]);
  assert.deepEqual(pinned.get(11).map(j => j.stage_id), [2]);
});

test('an unpinned job is listed ONCE for the section, not under every machine', () => {
  const jobs = [job({ id: 1 })];
  const { pinned, unpinned } = splitByMachine(jobs, [10, 11, 12]);
  assert.deepEqual(unpinned.map(j => j.stage_id), [1]);
  for (const id of [10, 11, 12]) assert.deepEqual(pinned.get(id), []);
});

test('a job pinned to a machine outside this board still appears in the section', () => {
  const jobs = [job({ id: 1, machine_id: 99 })];
  const { unpinned } = splitByMachine(jobs, [10]);
  assert.deepEqual(unpinned.map(j => j.stage_id), [1]);
});

test('splitByMachine returns every lane in board order', () => {
  const jobs = [job({ id: 1, machine_id: 10, floor_pos: 2 }), job({ id: 2, machine_id: 10, floor_pos: 1 })];
  assert.deepEqual(splitByMachine(jobs, [10]).pinned.get(10).map(j => j.stage_id), [2, 1]);
});

test('splitByMachine handles a section with no machines at all', () => {
  const { pinned, unpinned } = splitByMachine([job({ id: 1 })], []);
  assert.equal(pinned.size, 0);
  assert.deepEqual(unpinned.map(j => j.stage_id), [1]);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm test -w server -- --test-name-pattern="boardSort"`

Expected: FAIL — `Cannot find module './floor-order.js'`.

- [ ] **Step 3: Write the module**

Create `server/src/floor-order.js`:

```js
// The floor's own queue order.
//
// queue_pos belongs to Print Planning: it lives on job_cards, so it is ONE
// number shared by every section, and dragging a press lane writes it
// (production.js:665). An operator reordering die cutting must not reshuffle a
// planner's press lane, so the floor gets its own per-stage floor_pos and never
// writes queue_pos.
//
// A LANE is one section's queue as the board draws it: the jobs pinned to one
// machine, or the section's unpinned pool. A move never crosses lanes.

// Board order, used by every floor board so the four cannot drift: the floor's
// own order first, then Print Planning's, then delivery date, then job card id.
export const boardSort = (a, b) =>
  (a.floor_pos ?? 1e9) - (b.floor_pos ?? 1e9)
  || (a.queue_pos ?? 1e9) - (b.queue_pos ?? 1e9)
  || String(a.delivery_date ?? '9999').localeCompare(String(b.delivery_date ?? '9999'))
  || a.job_card_id - b.job_card_id;

// Number a lane 1..N in its current board order. Day one every floor_pos is
// NULL; without this the first move would swap two nulls and appear to do
// nothing. Returns copies — the caller's rows are left alone.
export const normalise = lane =>
  [...lane].sort(boardSort).map((j, i) => ({ ...j, floor_pos: i + 1 }));

// Move one job one place along its lane. Returns only the rows whose floor_pos
// actually changes, as { stage_id, floor_pos } — so the caller writes the
// minimum and can skip the audit entirely when nothing moved. Moving off either
// end returns [], which is a no-op and not an error: the operator pressed a
// button that had nowhere to go.
export function moveWithin(lane, stageId, dir) {
  const ordered = normalise(lane);
  const from = ordered.findIndex(j => j.stage_id === stageId);
  if (from === -1) return [];
  const to = dir === 'up' ? from - 1 : from + 1;
  if (to < 0 || to >= ordered.length) return [];

  const swapped = ordered.map(j => ({ ...j }));
  [swapped[from].floor_pos, swapped[to].floor_pos] = [swapped[to].floor_pos, swapped[from].floor_pos];

  const before = new Map(lane.map(j => [j.stage_id, j.floor_pos ?? null]));
  return swapped
    .filter(j => before.get(j.stage_id) !== j.floor_pos)
    .sort((a, b) => a.floor_pos - b.floor_pos)
    .map(j => ({ stage_id: j.stage_id, floor_pos: j.floor_pos }));
}

// Split a section's live work the way the board draws it: each machine's own
// pinned jobs, and the section's unpinned pool ONCE.
//
// /floor/machines used to rebuild the unpinned pool per machine (floor.js:351),
// so one unstarted die-cutting job was handed to all seven die-cutting cards —
// and because the top-3 slice ran after the merge, those duplicates pushed real
// pinned work off the card. A job pinned to a machine that is not on this board
// (a scoped-out press) falls into `unpinned` rather than vanishing; its row
// still prints its machine name.
export function splitByMachine(jobs, machineIds) {
  const pinned = new Map(machineIds.map(id => [id, []]));
  const unpinned = [];
  for (const j of jobs) {
    if (j.machine_id != null && pinned.has(j.machine_id)) pinned.get(j.machine_id).push(j);
    else unpinned.push(j);
  }
  for (const lane of pinned.values()) lane.sort(boardSort);
  unpinned.sort(boardSort);
  return { pinned, unpinned };
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npm test -w server`

Expected: PASS, all 16 new tests included, no existing test broken.

- [ ] **Step 5: Commit**

```bash
git add server/src/floor-order.js server/src/floor-order.test.js
git commit -m "feat(floor): the floor's own queue order, as a pure module"
```

---

### Task 2: The floor_pos column

**Files:**
- Modify: `server/src/db.js:586`
- Create: `supabase/migrations/0009_floor_queue_order.sql`
- Regenerate: `supabase/migrations/0001_baseline_schema.sql`

Editing `init()` does **not** migrate production — the numbered migration is what runs against Supabase. Both are required, and they must say the same thing.

- [ ] **Step 1: Add the column to init()**

In `server/src/db.js`, immediately after line 586 (`ALTER TABLE job_stages ADD COLUMN IF NOT EXISTS pack_qty_per_box INTEGER;`), add:

```sql
-- The Live Floor's own queue order, set by the up/down arrows on the board.
-- Separate from job_cards.queue_pos, which belongs to Print Planning: one
-- number per job shared by every section. NULL means "never reordered here".
ALTER TABLE job_stages ADD COLUMN IF NOT EXISTS floor_pos INTEGER;
```

- [ ] **Step 2: Write the migration**

Create `supabase/migrations/0009_floor_queue_order.sql`:

```sql
-- Live Floor queue order ---------------------------------------------------
-- The floor board grows up/down arrows on a queued job. They cannot write
-- job_cards.queue_pos: that column is ONE number per job card, shared by every
-- section, and it is what Print Planning writes when a press lane is dragged
-- (production.js:665) — so a move at die cutting would silently reshuffle a
-- planner's press lane.
--
-- floor_pos is per STAGE and is written only by POST /floor/queue/move. NULL
-- means the job has never been reordered on the floor, and every board sorts
-- floor_pos first, then queue_pos (see floor-order.js boardSort), so an
-- untouched plant keeps exactly the order it has today.
ALTER TABLE job_stages ADD COLUMN IF NOT EXISTS floor_pos INTEGER;
```

- [ ] **Step 3: Regenerate the baseline**

Run: `npm run db:baseline`

Then check what changed:

Run: `git diff --stat supabase/migrations/0001_baseline_schema.sql`

- [ ] **Step 4: Decide whether the baseline is yours to commit**

The baseline is generated from `db.js`, and `db.js` already carries another session's uncommitted approvals work — so the regenerated file may contain their schema too.

Run: `git diff supabase/migrations/0001_baseline_schema.sql`

- If the only added line is the `floor_pos` ALTER and its comment, include the file in the commit below.
- If it also contains `xs_approver`, `is_management`, `notifications` or anything else you did not write, **leave the file out of your commit** and say so in the handoff. `npm run verify` still passes locally because the file on disk is current; the other session commits it with their wave.

- [ ] **Step 5: Verify**

Run: `npm run verify`

Expected: baseline check passes, server tests pass, client builds.

- [ ] **Step 6: Commit**

```bash
git add server/src/db.js supabase/migrations/0009_floor_queue_order.sql
git commit -m "feat(floor): job_stages.floor_pos — a floor order that leaves Print Planning alone"
```

(Add `supabase/migrations/0001_baseline_schema.sql` to that `git add` only if Step 4 said it was yours.)

---

### Task 3: Sort every floor board through boardSort

Four boards currently repeat the same three-key comparator and none of them knows about `floor_pos`. Replace all four with the shared one.

**Files:**
- Modify: `server/src/routes/floor.js` (imports, 4 SELECTs, 4 sorts)

- [ ] **Step 1: Import the module**

In `server/src/routes/floor.js`, after the existing `import { toolingDetail, toolingGateOk } from '../tooling-gate.js';` (line 14), add:

```js
import { boardSort, moveWithin, splitByMachine } from '../floor-order.js';
```

- [ ] **Step 2: Select floor_pos in all four queries**

Each of these four SELECT lists already pulls `js.qty_in, js.qty_out`. Add `js.floor_pos,` to each:

1. `/floor` — line 149, the list starting `SELECT js.id, js.job_card_id, js.seq, js.stage, js.status, js.unit,`
2. `/floor/machines` — line 270, the list starting `SELECT js.id, js.job_card_id, js.seq, js.stage, js.status, js.unit,`
3. `/floor/:section` — the `STAGE_VIEW` constant at line 104 already does `SELECT js.*`, so it carries `floor_pos` for free. Nothing to change.
4. `/floor/sort-paste` — also builds on `STAGE_VIEW`. Nothing to change.

- [ ] **Step 3: Carry floor_pos into the entry objects**

In `/floor`, the entry literal at line 206 reads:

```js
          machine_name: s.machine_name, machine_id: s.machine_id, queue_pos: s.queue_pos, delivery_date: s.delivery_date,
```

Change to:

```js
          machine_name: s.machine_name, machine_id: s.machine_id,
          queue_pos: s.queue_pos, floor_pos: s.floor_pos, delivery_date: s.delivery_date,
```

In `/floor/machines`, line 315 reads:

```js
          queue_pos: s.queue_pos, delivery_date: s.delivery_date,
```

Change to:

```js
          queue_pos: s.queue_pos, floor_pos: s.floor_pos, delivery_date: s.delivery_date,
```

- [ ] **Step 4: Replace the four comparators**

**`/floor`** — delete the `laneSort` definition at lines 218-222 (including its two comment lines) and change the loop below it from `sec.running.sort(laneSort)` etc. to:

```js
    // Board order is one comparator shared by every floor board — see
    // floor-order.js. The floor's own order wins, then Print Planning's.
    for (const sec of Object.values(sections)) {
      sec.running.sort(boardSort); sec.held.sort(boardSort);
      sec.queued.sort(boardSort); sec.incoming.sort(boardSort);
    }
```

**`/floor/machines`** — the `jobSort` at lines 324-327 keeps its state ranking but delegates the rest:

```js
    const stateRank = { running: 0, hold: 1, queued: 2, incoming: 3 };
    const jobSort = (a, b) => stateRank[a.state] - stateRank[b.state] || boardSort(a, b);
```

**`/floor/:section`** — replace the sort at lines 479-481 with:

```js
    queue.sort(boardSort);
```

**`/floor/sort-paste`** — replace the identical sort at lines 600-602 with:

```js
    queue.sort(boardSort);
```

- [ ] **Step 5: Verify nothing regressed**

Run: `npm run verify`

Expected: PASS. With every `floor_pos` still NULL, `boardSort` reduces to the exact three keys the four comparators used, so the boards render in the same order as before.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/floor.js
git commit -m "refactor(floor): every floor board sorts through one comparator"
```

---

### Task 4: The reorder endpoint

**Files:**
- Modify: `server/src/routes/floor.js` (new route)

- [ ] **Step 1: Add the route**

In `server/src/routes/floor.js`, immediately before the `/floor/machines` route (line 267, the comment block starting `// ── Machine control board ──`), insert:

```js
// ── Floor queue order ───────────────────────────────────────────────────────
// Move one job one place along its lane. A lane is the queue as the BOARD draws
// it: the jobs pinned to one machine, or the section's unpinned pool. The move
// never crosses lanes and never touches job_cards.queue_pos, so Print Planning's
// press lanes are unaffected. Registered before /floor/:section so the path wins.
r.post('/floor/queue/move', canRun, async (req, res, next) => {
  try {
    const stageId = +req.body.job_stage_id;
    const dir = req.body.dir;
    if (!stageId) return res.status(400).json({ error: 'job_stage_id is required' });
    if (!['up', 'down'].includes(dir)) return res.status(400).json({ error: "dir must be 'up' or 'down'" });

    const moved = await tx(async (qc, oc) => {
      const me = await oc(`
        SELECT js.id, js.stage, js.status, js.machine_id, jc.machine_id AS press_machine_id
        FROM job_stages js JOIN job_cards jc ON jc.id = js.job_card_id
        WHERE js.id=$1 FOR UPDATE OF js`, [stageId]);
      if (!me) throw Object.assign(new Error('Stage not found'), { status: 404 });
      if (me.status === 'completed')
        throw Object.assign(new Error('A completed stage has left the queue'), { status: 409 });

      // Same pinning rule the machine board uses (floor.js:318): a stage is on
      // the machine it started on, and an unstarted printing stage is on the
      // press Print Planning pinned.
      const pinnedTo = row => row.machine_id ?? (row.stage === 'printing' ? row.press_machine_id : null);

      const rows = await qc(`
        SELECT js.id AS stage_id, js.job_card_id, js.stage, js.machine_id, js.floor_pos,
               jc.machine_id AS press_machine_id, jc.queue_pos, o.delivery_date
        FROM job_stages js
        JOIN job_cards jc ON jc.id = js.job_card_id
        LEFT JOIN order_lines ol ON ol.id = jc.order_line_id
        LEFT JOIN LATERAL (
          SELECT ol2.* FROM order_lines ol2
          WHERE ol2.gang_run_id = jc.gang_run_id ORDER BY ol2.id LIMIT 1
        ) gol ON jc.order_line_id IS NULL
        JOIN orders o ON o.id = COALESCE(ol.order_id, gol.order_id)
        WHERE js.stage=$1 AND js.status <> 'completed' AND jc.status IN ('open','in_progress')
        FOR UPDATE OF js`, [me.stage]);

      const mine = pinnedTo(me);
      const lane = rows.filter(rw => pinnedTo(rw) === mine);

      const writes = moveWithin(lane, stageId, dir);
      for (const w of writes)
        await qc('UPDATE job_stages SET floor_pos=$1 WHERE id=$2', [w.floor_pos, w.stage_id]);
      if (writes.length)
        await audit('job_stage', stageId, 'floor_reorder',
          `${me.stage}: moved ${dir} on the floor board`, qc, req.user.name);
      return writes.length > 0;
    });

    res.json({ moved });
  } catch (e) { next(e); }
});
```

- [ ] **Step 2: Import tx**

`floor.js` line 10 currently reads `import { q, one } from '../db.js';`. Change to:

```js
import { q, one, tx } from '../db.js';
```

- [ ] **Step 3: Verify it compiles and the suite is green**

Run: `npm run verify`

Expected: PASS.

- [ ] **Step 4: Exercise the endpoint against the live database**

Server edits may not hot-reload. Start a throwaway server on a spare port against the running Postgres:

```bash
cd server && PORT=4055 DATABASE_URL=postgres://postgres:postgres@localhost:5439/ci_erp node src/index.js
```

In another shell, log in and move a real queued job (pick any `stage_id` visible on the Live Floor):

```bash
curl -s -X POST localhost:4055/api/auth/login -H 'content-type: application/json' -d '{"email":"admin@motionci.com","password":"admin123"}'
```

Then, with the returned token:

```bash
curl -s -X POST localhost:4055/api/floor/queue/move -H 'content-type: application/json' -H "authorization: Bearer $TOKEN" -d '{"job_stage_id":<ID>,"dir":"up"}'
```

Expected: `{"moved":true}` the first time, and `{"moved":false}` once the job is at the top. Confirm `SELECT id, floor_pos FROM job_stages WHERE stage='<stage>'` shows a 1..N run, and that `SELECT id, queue_pos FROM job_cards` is unchanged.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/floor.js
git commit -m "feat(floor): move a job up or down its own lane"
```

---

### Task 5: One machine board, built once

`/floor` returns raw machine rows; `/floor/machines` computes jobs per machine with the duplicate-`shared` bug. Both now go through `splitByMachine`.

**Files:**
- Modify: `server/src/routes/floor.js` (`/floor` payload, `/floor/machines` body)

- [ ] **Step 1: Rewrite the /floor/machines job split**

In `/floor/machines`, replace the `board.map(...)` body (lines 347-366) with:

```js
    const machineIds = board.map(m => m.id);
    const byStage = {};
    for (const e of entries) (byStage[e.stage] ||= []).push(e);
    const splitByStage = Object.fromEntries(
      Object.entries(byStage).map(([stage, list]) => [stage, splitByMachine(list, machineIds)]));

    res.json(board.map(m => {
      // Only what is actually pinned to this machine. The section's unpinned
      // queue is a section-level lane now (see /floor) — handing it to every
      // machine of the type listed one job N times and pushed real work off the
      // top three.
      const jobs = (splitByStage[m.type]?.pinned.get(m.id) || []).sort(jobSort);
      return {
        id: m.id, name: m.name, type: m.type, status: m.status,
        capacity_per_hour: m.capacity_per_hour,
        live: jobs.some(e => e.state === 'running') ? 'running'
          : m.status === 'maintenance' ? 'maintenance'
          : jobs.some(e => e.state === 'hold') ? 'hold' : 'idle',
        today: todayBy[m.id] || { runs: 0, produced: 0 },
        jobs: jobs.slice(0, 3),
        more: Math.max(0, jobs.length - 3),
      };
    }));
```

`Production.jsx:52` reads only `id` and `name` from this endpoint, so narrowing `jobs` is safe.

- [ ] **Step 2: Give /floor the two facts the band needs but does not have**

The band shows each machine's output today, and hides the extra-sheets button on a job that already has a request open. Neither is in the `/floor` query.

In the `/floor` stages query, add a lateral for the open request. After the stock lateral (the block ending `) stk ON true`, line 178), add:

```sql
      LEFT JOIN LATERAL (
        SELECT xs_number FROM extra_sheet_requests
        WHERE job_card_id = jc.id AND status IN ('pending','approved') LIMIT 1) oxs ON true
```

and add `oxs.xs_number AS open_xs` to that query's SELECT list, next to the `board_pending` expression.

Carry it onto the entry, next to `board_pending: s.board_pending,`:

```js
          open_xs: s.open_xs,
```

Then add the per-machine day figures. After the `todayStats` query (line 229-237), add the machine twin — the same query `/floor/machines` already runs:

```js
    const todayRows = await q(`
      SELECT machine_id, COUNT(*)::int AS runs, COALESCE(SUM(qty_out),0)::int AS produced
      FROM job_stages
      WHERE status='completed' AND completed_at::date = current_date AND machine_id IS NOT NULL
      GROUP BY machine_id`);
    const todayBy = Object.fromEntries(todayRows.map(t => [t.machine_id, t]));
```

- [ ] **Step 3: Enrich the /floor payload with machines and the unpinned lane**

In `/floor`, replace the `payload` assignment (lines 240-244) with:

```js
    // One band per section: its machines with the work pinned to each, and the
    // section's own unpinned queue listed ONCE below them.
    let payload = SECTIONS.map(s => {
      const secMachines = machines.filter(m => m.type === s);
      const live = [...sections[s].running, ...sections[s].held,
                    ...sections[s].queued, ...sections[s].incoming];
      const { pinned, unpinned } = splitByMachine(live, secMachines.map(m => m.id));
      return {
        ...sections[s],
        machines: secMachines.map(m => {
          const jobs = pinned.get(m.id) || [];
          return {
            ...m,
            live: jobs.some(j => j.state === 'running') ? 'running'
              : m.status === 'maintenance' ? 'maintenance'
              : jobs.some(j => j.state === 'hold') ? 'hold' : 'idle',
            today: todayBy[m.id] || { runs: 0, produced: 0 },
            jobs: jobs.slice(0, 3),
            more: Math.max(0, jobs.length - 3),
          };
        }),
        unpinned: unpinned.slice(0, 3),
        unpinned_more: Math.max(0, unpinned.length - 3),
        today: statsByStage[s] || { completed_today: 0, received_today: 0, produced_today: 0, scrap_today: 0 },
      };
    });
```

- [ ] **Step 4: Give /floor entries the state the band needs**

`splitByMachine` sorts by `boardSort`, but the band needs each job's state to colour it. The `/floor` entry literal (line 197) does not carry one — the lane it landed in was the state. Add it. Inside the classification block at lines 211-214, replace:

```js
        if (state === 'running') sections[s.stage].running.push(entry);
        else if (state === 'hold') sections[s.stage].held.push(entry);
        else if (state === 'queued') sections[s.stage].queued.push(entry);
        else sections[s.stage].incoming.push(entry);
```

with:

```js
        entry.state = state;
        if (state === 'running' || state === 'partial') sections[s.stage].running.push(entry);
        else if (state === 'hold') sections[s.stage].held.push(entry);
        else if (state === 'queued') sections[s.stage].queued.push(entry);
        else sections[s.stage].incoming.push(entry);
```

(`frontierState` can return `'partial'` — a stage with day-wise counts recorded. It previously fell through to `incoming`, which read as "still upstream" for a stage that is in fact part-run. Grouping it with running is correct and is what `/floor/machines` already does via `stateRank`.)

- [ ] **Step 5: Keep the machine scope filter working**

`floorScope` filtering at lines 248-257 runs over the four lanes and `sec.machines`. It now runs before the machines are enriched. Move the whole `const { sections: allowSec, machineIds } = await floorScope(req);` block and its two `if` bodies to sit **above** the `let payload = SECTIONS.map(...)` from Step 2, and change the lane filter to operate on `sections[...]` instead of `payload`:

```js
    const { sections: allowSec, machineIds } = await floorScope(req);
    if (machineIds) {
      const keep = new Set(machineIds);
      for (const lane of ['running', 'held', 'queued', 'incoming'])
        sections.printing[lane] = sections.printing[lane].filter(e => e.machine_id != null && keep.has(e.machine_id));
    }
```

Then, after the `payload` map, keep the machine and section filters:

```js
    if (machineIds) {
      const keep = new Set(machineIds);
      for (const sec of payload) if (sec.section === 'printing') sec.machines = sec.machines.filter(m => keep.has(m.id));
    }
    if (allowSec) payload = payload.filter(s => allowSec.includes(s.section));
    res.json(payload);
```

- [ ] **Step 6: Verify**

Run: `npm run verify`

Then, on the throwaway server from Task 4:

```bash
curl -s localhost:4055/api/floor -H "authorization: Bearer $TOKEN" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const p=JSON.parse(s);for(const x of p)console.log(x.section, 'machines', x.machines.length, 'unpinned', x.unpinned.length, '+' + x.unpinned_more)})"
```

Expected: every section prints its machine count and a single unpinned lane. Confirm against the old behaviour that a job which used to appear under all N machines of a type now appears once, in `unpinned`.

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/floor.js
git commit -m "fix(floor): a section's unpinned queue is listed once, not per machine"
```

---

### Task 6: JobRow

**Files:**
- Create: `client/src/components/floor/JobRow.jsx`

- [ ] **Step 1: Write the component**

Create `client/src/components/floor/JobRow.jsx`:

```jsx
// One job on the Live Floor board — the facts an operator needs, and every
// control they are allowed to press, on the row itself. Replaces the old
// JobChip (section tiles) and MachineJobRow (machine cards), which showed the
// same job two different ways depending on which grid you were looking at.
import { Link } from 'react-router-dom';
import { fmt, auth } from '../../api.js';
import {
  Play, Check, PauseCircle, ArrowUp, ArrowDown, ArrowUpRight,
  CircleDashed, AlertTriangle, PackagePlus,
} from 'lucide-react';
import { GangChip } from '../Gang.jsx';
import { receivedQty } from '../../lib/received.js';

const canOperate = () => ['admin', 'production'].includes(auth.user?.role);
const canHold = () => ['admin', 'production', 'planner'].includes(auth.user?.role);
const canRequestSheets = () => ['admin', 'production', 'planner'].includes(auth.user?.role);

// The stages that run in sheets and can therefore receive extra board — the
// server's SHEET_STAGES (extrasheets.js). A carton-stage shortage is an FG
// problem, not a board problem, so the control is hidden there rather than
// offered and 409'd.
const SHEET_STAGES = ['cutting', 'printing', 'coating', 'lamination', 'foiling', 'embossing', 'die_cutting'];

// Extra sheets are accepted only against a running or held sheet stage with no
// request already open on the job card. Mirror all three so the button never
// appears where the server would refuse it.
export const canAskSheets = job => canRequestSheets()
  && SHEET_STAGES.includes(job.stage)
  && job.unit === 'sheets'
  && ['running', 'partial', 'hold'].includes(job.state)
  && !job.open_xs;

const jobLabel = job => job.gang_members?.length
  ? job.gang_members.map(m => m.product_name).join(' + ')
  : job.product_name;

function elapsed(t) {
  if (!t) return '';
  const mins = Math.max(0, Math.round((Date.now() - new Date(t).getTime()) / 60000));
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

const iconBtn = 'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition';

export default function JobRow({ job, onStart, onComplete, onHold, onResume, onSheets, onMove }) {
  const running = job.state === 'running' || job.state === 'partial';
  const tone = running ? 'border-amber-200 bg-amber-50/70'
    : job.state === 'hold' ? 'border-red-200 bg-red-50/60'
    : 'border-slate-200 bg-white/60';

  const stageHref = `/floor/${job.stage === 'sorting' || job.stage === 'pasting' ? 'sort-paste' : job.stage}?q=${encodeURIComponent(job.jc_number)}`;

  return (
    <div className={`flex items-center gap-2 rounded-xl border px-2.5 py-2 ${tone} ${job.gang_number ? 'border-l-[3px] !border-l-violet-400' : ''}`}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-extrabold text-slate-900">{job.jc_number}</span>
          {job.gang_number && <GangChip number={job.gang_number} />}
          {running && (
            <span className="flex items-center gap-1 text-[11px] font-semibold text-amber-700">
              <span className="h-1.5 w-1.5 animate-pulseSoft rounded-full bg-amber-500" />
              {elapsed(job.started_at)}
            </span>
          )}
          {job.board_pending && (
            <span className="flex items-center gap-1 text-[10px] font-bold text-amber-600"
              title="Board still to come — stock is short for this job's sheets">
              <AlertTriangle size={11} /> BOARD PENDING
            </span>
          )}
        </div>
        <div className="truncate text-[11px] text-slate-500" title={jobLabel(job)}>
          {jobLabel(job)}{job.gang_members?.length ? '' : ` · ${job.customer_name}`}
        </div>
        <div className="mt-0.5 truncate text-[11px] tabular-nums text-slate-600">
          {job.state === 'incoming'
            ? <span className="flex items-center gap-1 text-slate-400"><CircleDashed size={11} />after {fmt.stage(job.upstream?.stage || '')}</span>
            : job.state === 'hold'
              ? <span className="flex items-center gap-1 font-semibold text-red-600"><PauseCircle size={11} />on hold{job.hold_reason ? ` — ${job.hold_reason}` : ''}</span>
              : <>{fmt.num(receivedQty(job))} {job.unit}{job.operator ? ` · ${job.operator}` : ''}{job.machine_name ? ` · ${job.machine_name}` : ''}</>}
        </div>
      </div>

      {onMove && canOperate() && !running && job.state !== 'hold' && (
        <>
          <button onClick={() => onMove(job, 'up')} title="Move up the queue"
            className={`${iconBtn} text-slate-400 hover:bg-slate-100 hover:text-slate-700`}>
            <ArrowUp size={13} />
          </button>
          <button onClick={() => onMove(job, 'down')} title="Move down the queue"
            className={`${iconBtn} text-slate-400 hover:bg-slate-100 hover:text-slate-700`}>
            <ArrowDown size={13} />
          </button>
        </>
      )}

      {canHold() && running && (
        <button onClick={() => onHold(job)} title="Put this job on hold"
          className={`${iconBtn} text-amber-600 hover:bg-amber-100`}>
          <PauseCircle size={13} />
        </button>
      )}

      {canAskSheets(job) && (
        <button onClick={() => onSheets(job)} title="Request extra sheets"
          className={`${iconBtn} text-slate-500 hover:bg-slate-100 hover:text-brand-700`}>
          <PackagePlus size={13} />
        </button>
      )}

      {canHold() && job.state === 'hold' && (
        <button onClick={() => onResume(job)} title="Resume"
          className={`${iconBtn} btn-brand`}>
          <Play size={13} />
        </button>
      )}

      {canOperate() && running && (
        <button onClick={() => onComplete(job)} title="Complete"
          className={`${iconBtn} bg-amber-500 text-white shadow-sm hover:bg-amber-600`}>
          <Check size={13} />
        </button>
      )}

      {canOperate() && (job.state === 'queued' || job.state === 'incoming') && (
        <button onClick={() => onStart(job)}
          title={job.state === 'incoming'
            ? `Start ahead — ${fmt.stage(job.upstream?.stage || 'the previous stage')} hasn't finished; this stage can't be completed until it does`
            : 'Start'}
          className={`${iconBtn} ${job.state === 'queued' ? 'btn-brand' : 'border border-slate-300 bg-white text-slate-500 hover:border-brand-300 hover:text-brand-600'}`}>
          <Play size={13} />
        </button>
      )}

      <Link to={stageHref} title={`Open ${fmt.stage(job.stage)} — ${job.jc_number}`}
        className={`${iconBtn} bg-slate-100 text-slate-500 hover:bg-brand-100 hover:text-brand-700`}>
        <ArrowUpRight size={13} />
      </Link>
    </div>
  );
}
```

- [ ] **Step 2: Confirm it builds**

Run: `npm run build -w client`

Expected: PASS (the component is not imported yet; this only proves it parses).

- [ ] **Step 3: Commit**

```bash
git add client/src/components/floor/JobRow.jsx
git commit -m "feat(floor): one job row, with its controls on it"
```

---

### Task 7: MachineBlock and SectionBand

**Files:**
- Create: `client/src/components/floor/MachineBlock.jsx`
- Create: `client/src/components/floor/SectionBand.jsx`

- [ ] **Step 1: Write MachineBlock**

Create `client/src/components/floor/MachineBlock.jsx`:

```jsx
// One machine inside its section band: name, live state, today's output, the
// controls menu, and the jobs actually pinned to it. A machine with nothing on
// it is a single line — the old MachineCard gave an idle machine a 180px card
// with an empty-state box in the middle of it.
import { ActionMenu } from '../ui.jsx';
import { fmt, auth } from '../../api.js';
import { ScrollText, Wrench, Power, CircleDot } from 'lucide-react';
import JobRow from './JobRow.jsx';

const canOperate = () => ['admin', 'production'].includes(auth.user?.role);

export default function MachineBlock({ m, onLog, onStatus, jobHandlers }) {
  const dot = m.live === 'running' ? 'bg-amber-500 animate-pulseSoft'
    : m.live === 'hold' ? 'bg-red-500'
    : m.live === 'maintenance' ? 'bg-slate-400' : 'bg-slate-300';

  return (
    <div className="border-t border-slate-100 first:border-t-0">
      <div className="flex items-center gap-2 px-4 py-2.5">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
        <span className="truncate text-xs font-extrabold text-slate-900">{m.name}</span>
        <span className="truncate text-[11px] text-slate-400">
          {m.live === 'hold' ? 'on hold' : m.live}
          {m.jobs.length === 0 && ' · nothing lined up'}
          {m.today?.runs > 0 && <span className="ml-1 text-emerald-600">· {fmt.num(m.today.produced)} out today</span>}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {canOperate() && (
            <ActionMenu label={`${m.name} controls`} items={[
              { label: 'View machine log', icon: ScrollText, onClick: () => onLog(m) },
              { label: 'Back in service', icon: CircleDot, onClick: () => onStatus(m, 'running') },
              { label: 'Mark idle', icon: Power, onClick: () => onStatus(m, 'idle') },
              { label: 'Under maintenance', icon: Wrench, tone: 'danger', onClick: () => onStatus(m, 'maintenance') },
            ]} />
          )}
        </div>
      </div>

      {m.jobs.length > 0 && (
        <div className="space-y-1.5 px-3 pb-3">
          {m.jobs.map(j => <JobRow key={j.stage_id} job={j} {...jobHandlers} />)}
          {m.more > 0 && (
            <div className="px-1 text-[11px] text-slate-400">+{m.more} more on this machine</div>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Write SectionBand**

Create `client/src/components/floor/SectionBand.jsx`:

```jsx
// One production section, full width. Clear sections collapse to a single row —
// the old three-column grid gave a clear section a ~200px tile with "Section
// clear" in the middle, so a quiet shift rendered as a wall of empty cards.
import { Link } from 'react-router-dom';
import { fmt } from '../../api.js';
import { ChevronRight } from 'lucide-react';
import { SECTION_META, SORT_PASTE_META } from '../../sections.js';
import MachineBlock from './MachineBlock.jsx';
import JobRow from './JobRow.jsx';

export default function SectionBand({ sec, onLog, onStatus, jobHandlers }) {
  const meta = sec.merged ? SORT_PASTE_META : SECTION_META[sec.section];
  const Icon = meta.icon;
  const to = sec.merged ? '/floor/sort-paste' : `/floor/${sec.section}`;
  const machines = sec.machines || [];
  const up = machines.filter(m => m.live === 'running').length;
  const queued = sec.queued.length + sec.incoming.length;
  const clear = sec.running.length + (sec.held || []).length + queued === 0;

  if (clear) {
    return (
      <Link to={to}
        className="group flex items-center gap-2.5 rounded-[18px] border border-white/70 bg-white/50 px-4 py-3 backdrop-blur-xl transition hover:bg-white/80">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-400">
          <Icon size={14} />
        </span>
        <span className="text-sm font-extrabold text-slate-400 group-hover:text-slate-700">{meta.label}</span>
        <span className="truncate text-[11px] text-slate-400">
          clear · 0 in queue{machines.length > 0 && ` · ${machines.length} machine${machines.length > 1 ? 's' : ''} idle`}
        </span>
        <ChevronRight size={14} className="ml-auto shrink-0 text-slate-300 transition-transform group-hover:translate-x-0.5" />
      </Link>
    );
  }

  return (
    <div className="rounded-[22px] border border-white/70 bg-white/65 shadow-card backdrop-blur-xl transition-shadow hover:shadow-lift">
      <Link to={to} className="group flex items-center gap-2.5 border-b border-slate-100 px-4 py-3">
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${meta.tint}`}>
          <Icon size={15} />
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-1 text-sm font-extrabold text-slate-900 group-hover:text-indigo-800">
            {meta.label}
            <ChevronRight size={13} className="text-slate-300 transition-transform group-hover:translate-x-0.5 group-hover:text-indigo-500" />
          </div>
          <div className="text-[11px] text-slate-400">
            {machines.length > 0 ? `${up}/${machines.length} machines up` : 'bench section'}
            {sec.today?.completed_today > 0 && (
              <span className="ml-1.5 text-emerald-600">· {fmt.num(sec.today.produced_today)} out today</span>
            )}
          </div>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {sec.running.length > 0 && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-700">
              {sec.running.length} running
            </span>
          )}
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${queued ? 'bg-brand-100 text-brand-700' : 'bg-slate-100 text-slate-400'}`}>
            {queued} in queue
          </span>
        </div>
      </Link>

      {machines.map(m => (
        <MachineBlock key={m.id} m={m} onLog={onLog} onStatus={onStatus} jobHandlers={jobHandlers} />
      ))}

      {(sec.unpinned?.length > 0 || (sec.held || []).length > 0) && (
        <div className="border-t border-slate-100 px-3 pb-3 pt-2.5">
          <div className="mb-1.5 px-1 text-[10px] font-extrabold uppercase tracking-wide text-slate-400">
            {machines.length > 0 ? 'Section queue — not yet on a machine' : 'Section queue'}
          </div>
          <div className="space-y-1.5">
            {(sec.held || []).map(j => <JobRow key={j.stage_id} job={j} {...jobHandlers} />)}
            {(sec.unpinned || []).map(j => <JobRow key={j.stage_id} job={j} {...jobHandlers} />)}
            {sec.unpinned_more > 0 && (
              <Link to={to} className="block px-1 text-[11px] text-slate-400 hover:text-brand-700">
                +{sec.unpinned_more} more in this queue →
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Confirm both build**

Run: `npm run build -w client`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/floor/MachineBlock.jsx client/src/components/floor/SectionBand.jsx
git commit -m "feat(floor): section bands with their machines nested"
```

---

### Task 8: Rebuild the page

**Files:**
- Modify: `client/src/pages/Floor.jsx`

- [ ] **Step 1: Delete the three old components**

In `client/src/pages/Floor.jsx`, delete `JobChip` (lines 31-89), `MachineJobRow` (lines 91-122) and `MachineCard` (lines 124-184) in full, along with the now-unused `elapsed` helper (lines 24-29) — `JobRow` has its own.

- [ ] **Step 2: Replace the imports**

The import block at lines 3-14 becomes:

```jsx
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, fmt, auth } from '../api.js';
import { Button, ExportMenu, Field, Input, Modal, PageHeader, rowMatches, SearchInput, Select, useToast } from '../components/ui.jsx';
import { Play, PackagePlus } from 'lucide-react';
import { SECTION_META, SORT_PASTE_META, HOLD_REASONS } from '../sections.js';
import LineClearancePanel, { needsClearance, freshClearance, allClear, clearancePayload } from '../components/LineClearance.jsx';
import { GangMemberList } from '../components/Gang.jsx';
import { receivedQty } from '../lib/received.js';
import SectionBand from '../components/floor/SectionBand.jsx';
```

Keep the `jobLabel` and `canOperate` helpers at lines 18-22 — the export builder and modals still use them.

- [ ] **Step 3: Drop the second fetch**

`/floor` now carries the machines, so the load at lines 199-202 becomes:

```jsx
  const load = () => api.get('/floor').then(setSections);
```

Delete the `machines` state (line 190). Where the header and export need a flat machine list, derive it:

```jsx
  const allMachines = useMemo(
    () => (sections || []).flatMap(s => s.machines || []), [sections]);
```

- [ ] **Step 4: Add the three new actions**

Add state next to the existing `completing` / `clearing` state:

```jsx
  const [holding, setHolding] = useState(null);      // job → hold reason modal
  const [holdReason, setHoldReason] = useState(HOLD_REASONS[0]);
  const [sheets, setSheets] = useState(null);        // job → extra sheet request
  const [sheetForm, setSheetForm] = useState({ qty: '', reason: '', note: '' });
```

And the handlers, next to `start` / `complete`:

```jsx
  const hold = async () => {
    await api.post(`/job-stages/${holding.stage_id}/hold`, { reason: holdReason });
    toast.success(`${holding.jc_number} on hold`);
    setHolding(null);
    load();
  };
  const resume = async job => {
    await api.post(`/job-stages/${job.stage_id}/resume`, {});
    toast.success(`${job.jc_number} resumed`);
    load();
  };
  // The floor RAISES a CI-XS request; the plant head approves it and the
  // warehouse issues the board. Nothing here puts sheets on a machine.
  const askSheets = async () => {
    const xs = await api.post('/extra-sheets', {
      job_stage_id: sheets.stage_id,
      qty: +sheetForm.qty,
      reason: sheetForm.reason,
      note: sheetForm.note || null,
    });
    toast.success(`${xs.xs_number} raised — sent to the plant head for approval`);
    setSheets(null);
    load();
  };
  const move = async (job, dir) => {
    const { moved } = await api.post('/floor/queue/move', { job_stage_id: job.stage_id, dir });
    if (!moved) return toast.info(`${job.jc_number} is already ${dir === 'up' ? 'first' : 'last'} in this queue`);
    load();
  };
```

Then bundle them for the band. The merged Sort & Paste station still sends start/complete to its own workspace, because that station enforces the waste gate:

```jsx
  const jobHandlers = useMemo(() => ({
    onStart: start, onComplete: openComplete, onHold: j => { setHolding(j); setHoldReason(HOLD_REASONS[0]); },
    onResume: resume, onMove: move,
    onSheets: j => { setSheets(j); setSheetForm({ qty: '', reason: '', note: '' }); },
  }), []);
  const sortPasteHandlers = useMemo(() => ({
    ...jobHandlers, onStart: () => nav('/floor/sort-paste'), onComplete: () => nav('/floor/sort-paste'),
  }), [jobHandlers]);
```

- [ ] **Step 5: Replace the two grids with one stack**

Delete the whole Machine Control block (lines 348-364) and the Sections grid (lines 366-430). In their place:

```jsx
      <h2 className="mb-2.5 text-sm font-extrabold tracking-[-0.01em] text-slate-900">Sections</h2>
      {q.trim() && !searched.sections.length && (
        <div className="rounded-2xl border border-dashed border-slate-200 py-10 text-center text-sm text-slate-400">
          Nothing on the floor matches “{q}”.
        </div>
      )}
      <div className="space-y-3">
        {searched.sections.map(sec => (
          <SectionBand key={sec.section} sec={sec} onLog={openLog} onStatus={setMachineStatus}
            jobHandlers={sec.merged ? sortPasteHandlers : jobHandlers} />
        ))}
      </div>
```

- [ ] **Step 6: Teach the search about the new lanes**

The `searched` memo (lines 283-298) filters four lanes and a separate machine list. It now filters five lanes and the jobs inside each machine, and drops the machine branch entirely:

```jsx
  const searched = useMemo(() => {
    const hit = j => rowMatches(j, q, jobLabel(j));
    if (!q.trim()) return { sections: displaySections };
    const secs = (displaySections || []).map(s => ({
      ...s,
      running: s.running.filter(hit),
      held: (s.held || []).filter(hit),
      queued: s.queued.filter(hit),
      incoming: s.incoming.filter(hit),
      unpinned: (s.unpinned || []).filter(hit),
      machines: (s.machines || []).map(m => ({ ...m, jobs: (m.jobs || []).filter(hit) })),
    })).filter(s =>
      s.running.length + s.held.length + s.queued.length + s.incoming.length > 0
      // the tile's own label, or one of its machines by name — searching a
      // section or a machine should open that band even when it stands idle,
      // which is exactly when someone looks it up
      || (s.machines || []).some(m => rowMatches({ ...m, jobs: undefined }, q))
      || rowMatches({ section: s.section }, q, (s.merged ? SORT_PASTE_META : SECTION_META[s.section])?.label || ''));
    return { sections: secs };
  }, [displaySections, q]);
```

- [ ] **Step 7: Merge unpinned for Sort & Paste**

The `displaySections` memo (lines 247-271) merges sorting + pasting. Add the two new keys to the merged object, next to `machines`:

```jsx
          machines: [...(s.machines || []), ...(p.machines || [])],
          unpinned: [...(s.unpinned || []), ...(p.unpinned || [])],
          unpinned_more: (s.unpinned_more || 0) + (p.unpinned_more || 0),
```

- [ ] **Step 8: Add the two new modals**

After the existing line-clearance modal, add:

```jsx
      <Modal open={!!holding} onClose={() => setHolding(null)}
        title={holding ? `Hold ${fmt.stage(holding.stage)} — ${holding.jc_number}` : ''}
        footer={<>
          <Button variant="secondary" onClick={() => setHolding(null)}>Cancel</Button>
          <Button variant="danger" onClick={hold}>Put on Hold</Button>
        </>}>
        {holding && (
          <Field label="Why is this job stopping?" required>
            <Select value={holdReason} onChange={e => setHoldReason(e.target.value)}>
              {HOLD_REASONS.map(h => <option key={h} value={h}>{h}</option>)}
            </Select>
          </Field>
        )}
      </Modal>

      <Modal open={!!sheets} onClose={() => setSheets(null)}
        title={sheets ? `Request Extra Sheets — ${sheets.jc_number}` : ''}
        footer={<>
          <Button variant="secondary" onClick={() => setSheets(null)}>Cancel</Button>
          <Button onClick={askSheets} disabled={!sheetForm.qty || !sheetForm.reason.trim()}>
            <PackagePlus size={13} /> Raise Request
          </Button>
        </>}>
        {sheets && (
          <div className="space-y-3">
            <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
              {sheets.product_name} · {fmt.stage(sheets.stage)} · received <b>{fmt.num(receivedQty(sheets))} {sheets.unit}</b>
              <div className="mt-1 text-slate-400">
                This raises a CI-XS request. The plant head approves it and the warehouse issues the board — no sheets move yet.
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Extra parent sheets" required>
                <Input type="number" min="1" value={sheetForm.qty}
                  onChange={e => setSheetForm({ ...sheetForm, qty: e.target.value })} />
              </Field>
              <Field label="Reason" required>
                <Input value={sheetForm.reason} placeholder="Setup wastage"
                  onChange={e => setSheetForm({ ...sheetForm, reason: e.target.value })} />
              </Field>
            </div>
            <Field label="Note">
              <Input value={sheetForm.note} onChange={e => setSheetForm({ ...sheetForm, note: e.target.value })} />
            </Field>
          </div>
        )}
      </Modal>
```

- [ ] **Step 9: Point the export at the new shape**

In the `ExportMenu` build (lines 311-345), the Machine Control section's `rows: machines || []` becomes `rows: allMachines`, and its `jobs` column export becomes:

```jsx
                { key: 'jobs', label: 'Jobs on Machine', export: m => (m.jobs || []).map(j => j.jc_number).join(', ') || '—' },
```

The header's machine count (line 318) becomes:

```jsx
            { label: 'Machines up', value: `${allMachines.filter(m => m.live === 'running').length}/${allMachines.length}` },
```

- [ ] **Step 10: Build**

Run: `npm run verify`

Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add client/src/pages/Floor.jsx
git commit -m "feat(floor): Live Floor is one stack of section bands"
```

---

### Task 9: Verify in the real app

Theme and UI changes get judged in the running app at a desktop breakpoint, logged in — never a mock.

**Files:** none

- [ ] **Step 1: Start the app**

Use the preview tooling (`.claude/launch.json`), not a bare `npm run dev` in Bash. If the dev server is already up on :4000, restart it — a wave of server-file edits can silently kill the `node --watch` process, and pages that swallow errors then render as fake-empty.

- [ ] **Step 2: Log in and open Live Floor**

`admin@motionci.com` / `admin123` on the embedded database. Navigate to `/floor`.

- [ ] **Step 3: Check each claim from the spec**

- Every section renders as a band; there is no Machine Control grid above them.
- A section with no work is a single ~44px row, not a tile with an empty-state box.
- Machines appear inside their section, each listing at most three jobs.
- A queued job that is on no machine appears **once**, under "Section queue", not under every machine of that type.
- A queued row has ▲ ▼ arrows; pressing ▲ moves it up and the order survives a refresh.
- A running row has hold, extra sheets and complete; a held row has resume.
- The extra-sheets button is absent on a QC/carton-unit row and on a job that already has an open CI-XS.
- Searching a machine name opens that band even when the section is clear.

- [ ] **Step 4: Confirm Print Planning is untouched**

Open Print Planning, note the press lane order, move a printing job on the Live Floor, and reload Print Planning. The lane order must be unchanged — `floor_pos` is a different column from `queue_pos`.

- [ ] **Step 5: Screenshot the before/after**

Capture the board with work on it and share it. The change is judged at a glance.

---

## Handoff notes

- **Nothing is deployed by this plan.** `git push origin main` deploys production via the Vercel Git integration. Do not push. Migration `0009` must be applied to Supabase separately, after `npm run db:backup`, and after the other session's `0007` and `0008` land.
- **Check `main` is not stale before any later deploy** — origin/main has drifted behind production before.
- If Step 4 of Task 2 left `0001_baseline_schema.sql` uncommitted, say so explicitly in the final report so the other session's wave picks it up.
