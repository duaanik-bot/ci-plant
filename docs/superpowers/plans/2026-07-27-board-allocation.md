# Board Allocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a planner hold warehouse board for a specific job, and move that hold between jobs from the PR row or the Planning Engine, with the losing job's PR auto-raised and the winning job's PR shrunk so net board purchased never changes.

**Architecture:** One new table (`board_allocations`) turns today's derived "committed" number into an editable record. All arithmetic lives in a new pure module `server/src/board-allocation.js` that takes plain rows and returns numbers — no database handles — so the formula that decides real purchase quantities is unit-testable. The module is a strict generalisation of the formula running today: with an empty allocations table it returns identical results, and a property test enforces that.

**Tech Stack:** Node 20 ESM, Express, Postgres (`pg`), `node:test` + `node:assert/strict` for tests, React 18 + Vite + Tailwind on the client.

**Spec:** `docs/superpowers/specs/2026-07-27-board-allocation-design.md`

---

## Before you start

Read these first. The plan assumes you know them.

- `docs/superpowers/specs/2026-07-27-board-allocation-design.md` — the design and why each decision was made.
- `CLAUDE.md` — project rules. Note especially: `init()` in `server/src/db.js` does **not** migrate production; production is migrated by a named Supabase migration.
- `DEPLOYMENT.md` §3 — the database change procedure. Task 5 follows it exactly.

**Environment.** Local Postgres is embedded at `postgresql://postgres:postgres@localhost:5439/cierp`. Start everything with `npm run dev` from the repo root (server on `:4000`, client on `:5173`). Login for local testing: `admin@motionci.com` / `admin123`.

**Two known traps in this repo:**

1. A wave of server-file edits can silently kill the `node --watch` server on `:4000`. Pages that swallow errors then render as empty rather than broken. If data vanishes from a screen, restart the server before debugging anything else.
2. Several Claude sessions may edit this one tree at once. Run `git status --short --branch` before staging, and prefer exact-string edits over whole-file rewrites.

**Commits.** `CLAUDE.md` permits git operations in this repo for release work. Commit after each task as written below. Do not push or deploy — that is a separate, explicitly requested step.

**Test command** (run from repo root):

```bash
npm test -w server
```

**Full verification** (baseline freshness + tests + client build):

```bash
npm run verify
```

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `server/src/board-allocation.js` | All allocation arithmetic. Pure — rows in, numbers out. Board position, per-line position, move planning and validation. |
| `server/src/board-allocation.test.js` | Unit tests, including the property test proving equivalence with today's formula. |
| `server/src/routes/board.js` | HTTP surface: panel read, move preview, move commit, release. |
| `supabase/migrations/0005_board_allocations.sql` | Named production migration for the new table. |
| `client/src/components/BoardCommitments.jsx` | The shared panel + move dialog. Used by Procurement, Planning and Masters 360. |

**Modified:**

| File | Change |
|---|---|
| `server/src/db.js` | `board_allocations` table + indexes inside `init()`. |
| `server/src/helpers.js` | Export `EFF_BOARD_ID` (currently duplicated in two routes). |
| `server/src/routes/orders.js` | Import `EFF_BOARD_ID`; planning context uses the new math. |
| `server/src/routes/gangs.js` | Import `EFF_BOARD_ID`. |
| `server/src/routes/procurement.js` | Keep PR ↔ allocation mirrored; add `/requisitions/:id/reassign`. |
| `server/src/routes/inventory.js` | `/inventory/demand/:materialId` gains held/free. |
| `server/src/routes/production.js` | Amber warning before board issue at first-stage start. |
| `server/src/app.js` | Mount the new router. |
| `client/src/pages/Planning.jsx` | Send `order_line_id` on PR raise; open the panel from the short banner. |
| `client/src/pages/Procurement.jsx` | Stock line on the PR row; open the panel. |

---

## Task 1: PRs remember which job they are for

Nothing downstream works until a requisition knows its order line. The column exists (`server/src/db.js:774`) and the API already accepts it (`server/src/routes/procurement.js:197`) — the planning engine simply never sends it.

**Files:**
- Modify: `client/src/pages/Planning.jsx:655-668`

- [ ] **Step 1: Confirm the gap is real**

```bash
grep -n "order_line_id" client/src/pages/Planning.jsx
```

Expected: no matches. If there are matches, this task is already done — skip to Task 2.

- [ ] **Step 2: Send the order line when raising a PR**

In `client/src/pages/Planning.jsx`, find `raisePrInline` and add `order_line_id` to the POST body:

```js
      const pr = await api.post('/requisitions', {
        material_id: boardSel.id,
        qty,
        needed_by: planLine.delivery_date,
        order_line_id: planLine.id,
        reason: `Shortfall for ${planLine.product_name} (PO ${planLine.po_number}) — planning engine`,
        ...(opts.reraise_of ? { reraise_of: opts.reraise_of, reraise_reason: opts.reraise_reason } : {}),
      });
```

- [ ] **Step 3: Verify against the running app**

Start the app (`npm run dev`), log in, open Planning, pick a line that is short, raise a PR. Then check the database directly:

```bash
psql "postgresql://postgres:postgres@localhost:5439/cierp" -c \
  "SELECT pr_number, material_id, qty, order_line_id FROM requisitions ORDER BY id DESC LIMIT 3;"
```

Expected: the newest row has a non-null `order_line_id`.

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/Planning.jsx
git commit -m "fix(planning): record the order line on a shortfall PR"
```

---

## Task 2: One definition of a line's effective board

`EFF_BOARD_ID` is copy-pasted in `server/src/routes/orders.js:22` and `server/src/routes/gangs.js:20`. This wave adds a third consumer. Move it to `helpers.js` before it becomes three copies that can drift.

**Files:**
- Modify: `server/src/helpers.js`
- Modify: `server/src/routes/orders.js:22`
- Modify: `server/src/routes/gangs.js:20`

- [ ] **Step 1: Add the shared constant to helpers**

In `server/src/helpers.js`, near the other query fragments:

```js
// A line's EFFECTIVE board: a warehouse pick made in the planning engine
// (spec_override) always beats the product master. Every query that resolves a
// line to a board MUST use this, or a "stolen" board reads as free. Expects the
// query to alias order_lines as `ol` and products as `p`.
export const EFF_BOARD_ID =
  `COALESCE((ol.spec_override->>'board_material_id')::int, p.board_material_id)`;
```

- [ ] **Step 2: Import it in orders.js**

In `server/src/routes/orders.js`, delete the local `const EFF_BOARD_ID = ...` on line 22 and add `EFF_BOARD_ID` to the existing import from `../helpers.js`.

- [ ] **Step 3: Import it in gangs.js**

Same change in `server/src/routes/gangs.js` — delete the local constant on line 20, add `EFF_BOARD_ID` to the `../helpers.js` import.

- [ ] **Step 4: Verify nothing broke**

```bash
grep -rn "const EFF_BOARD_ID" server/src/
```

Expected: exactly one match, in `server/src/helpers.js`.

```bash
npm test -w server
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/helpers.js server/src/routes/orders.js server/src/routes/gangs.js
git commit -m "refactor: single definition of EFF_BOARD_ID in helpers"
```

---

## Task 3: The position math, and proof it matches today

This is the heart of the wave. Written test-first because the number it returns becomes a real purchase order.

**Files:**
- Create: `server/src/board-allocation.js`
- Create: `server/src/board-allocation.test.js`

- [ ] **Step 1: Write the failing tests**

Create `server/src/board-allocation.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boardPosition, lineNeed, openNeed, linePosition } from './board-allocation.js';

// A literal transcription of the formula running in production today
// (server/src/routes/orders.js, planning context). The property test below
// asserts the new engine agrees with it whenever nothing is allocated.
function legacyNet({ lineId, lines, available }) {
  const me = lines.find(l => l.id === lineId);
  const committedOther = lines
    .filter(l => l.id !== lineId)
    .reduce((s, l) => s + Number(l.parent_sheets_required ?? l.sheets_required ?? 0), 0);
  const need = Number(me.parent_sheets_required ?? me.sheets_required ?? 0);
  return available - committedOther - need;
}

const LINES = [
  { id: 1, parent_sheets_required: 41742 },
  { id: 2, parent_sheets_required: 20000 },
  { id: 3, parent_sheets_required: 6000 },
];

test('lineNeed: parent sheets win, child sheets are the fallback', () => {
  assert.equal(lineNeed({ parent_sheets_required: 500, sheets_required: 9000 }), 500);
  assert.equal(lineNeed({ parent_sheets_required: null, sheets_required: 9000 }), 9000);
  assert.equal(lineNeed({}), 0);
});

test('boardPosition: free is what is left after every active hold', () => {
  const p = boardPosition({
    available: 26000,
    allocations: [
      { order_line_id: 1, qty: 20000, source: 'stock', status: 'active' },
      { order_line_id: 2, qty: 5000, source: 'stock', status: 'released' },
      { order_line_id: 3, qty: 9000, source: 'requisition', status: 'active' },
    ],
  });
  assert.equal(p.available, 26000);
  assert.equal(p.held, 20000, 'released holds and incoming PRs must not count as held stock');
  assert.equal(p.free, 6000);
});

test('openNeed: what a job still has to find, after holds and incoming', () => {
  const line = { id: 1, parent_sheets_required: 41742 };
  const allocations = [
    { order_line_id: 1, qty: 20000, source: 'stock', status: 'active' },
    { order_line_id: 1, qty: 21742, source: 'requisition', status: 'active' },
  ];
  assert.equal(openNeed(line, allocations), 0);
  assert.equal(openNeed(line, []), 41742);
});

test('openNeed: never negative, even if over-held', () => {
  const line = { id: 1, parent_sheets_required: 1000 };
  const allocations = [{ order_line_id: 1, qty: 5000, source: 'stock', status: 'active' }];
  assert.equal(openNeed(line, allocations), 0);
});

// ── The property that makes this safe to ship ────────────────────────────────
test('PROPERTY: with no allocations, the new engine equals the old formula', () => {
  for (const available of [0, 1, 6000, 26000, 41742, 100000]) {
    for (const lineId of [1, 2, 3]) {
      const fresh = linePosition({ lineId, lines: LINES, available, allocations: [] });
      const old = legacyNet({ lineId, lines: LINES, available });
      assert.equal(fresh.net, old,
        `net disagreed for line ${lineId} at available=${available}`);
      assert.equal(fresh.short, Math.max(0, -old),
        `short disagreed for line ${lineId} at available=${available}`);
    }
  }
});

test('linePosition: a hold covers the holder and pushes everyone else short', () => {
  const allocations = [{ order_line_id: 1, qty: 20000, source: 'stock', status: 'active' }];
  const mine = linePosition({ lineId: 1, lines: LINES, available: 26000, allocations });
  assert.equal(mine.held_for_me, 20000);
  assert.equal(mine.my_open_need, 21742);

  const theirs = linePosition({ lineId: 2, lines: LINES, available: 26000, allocations });
  assert.equal(theirs.free, 6000, 'the held 20,000 is no longer free');
  assert.equal(theirs.held_for_me, 0);
  assert.equal(theirs.my_open_need, 20000);
});

test('linePosition: only planned/ready lines compete — callers pass the filtered set', () => {
  const p = linePosition({ lineId: 1, lines: [LINES[0]], available: 50000, allocations: [] });
  assert.equal(p.others_open_need, 0);
  assert.equal(p.short, 0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -w server
```

Expected: FAIL — `Cannot find module './board-allocation.js'`.

- [ ] **Step 3: Write the module**

Create `server/src/board-allocation.js`:

```js
// Board allocation arithmetic. PURE — plain rows in, numbers out. No pg, no
// await, nothing to mock. The numbers here decide real purchase quantities, so
// they are unit-tested against a transcription of the formula they replace.
//
// A board's stock splits three ways:
//   available = what the warehouse physically has
//   held      = the part earmarked for named jobs (board_allocations)
//   free      = available - held, the part still up for grabs
//
// A job's requirement splits the same way: some held for it from stock, some
// already on order for it, and an OPEN NEED that still has to come from free
// stock or a new purchase. Only open needs compete.
//
// With an empty allocations table every hold is zero, so free == available and
// every open need == the full requirement — which reduces exactly to the
// pre-allocation formula. See the PROPERTY test in board-allocation.test.js.

const num = v => Number(v || 0);
const isActive = a => a.status === 'active';

// Board demand is counted in PARENT (mother) sheets — the unit the warehouse
// stocks and every Available column reports. sheets_required is the CHILD print
// sheet count, so using it raw over-states demand by children_per_parent.
export function lineNeed(line) {
  return num(line?.parent_sheets_required ?? line?.sheets_required);
}

export function heldFor(allocations = [], orderLineId) {
  return allocations
    .filter(a => isActive(a) && a.source === 'stock' && a.order_line_id === orderLineId)
    .reduce((s, a) => s + num(a.qty), 0);
}

export function incomingFor(allocations = [], orderLineId) {
  return allocations
    .filter(a => isActive(a) && a.source === 'requisition' && a.order_line_id === orderLineId)
    .reduce((s, a) => s + num(a.qty), 0);
}

export function boardPosition({ available, allocations = [] }) {
  const avail = num(available);
  const held = allocations
    .filter(a => isActive(a) && a.source === 'stock')
    .reduce((s, a) => s + num(a.qty), 0);
  return { available: avail, held, free: avail - held };
}

// What this job still has to find. Clamped at zero: over-holding a job is a
// data state to tolerate, not a negative demand that would credit other jobs.
export function openNeed(line, allocations = []) {
  return Math.max(0, lineNeed(line) - heldFor(allocations, line.id) - incomingFor(allocations, line.id));
}

// One line's full picture. `lines` must already be filtered to the planned/ready
// lines competing for THIS board — the caller owns that query.
export function linePosition({ lineId, lines = [], available, allocations = [] }) {
  const me = lines.find(l => l.id === lineId) || { id: lineId };
  const { held, free } = boardPosition({ available, allocations });
  const myOpen = openNeed(me, allocations);
  const othersOpen = lines
    .filter(l => l.id !== lineId)
    .reduce((s, l) => s + openNeed(l, allocations), 0);
  const net = free - myOpen - othersOpen;
  return {
    available: num(available),
    held,
    free,
    need: lineNeed(me),
    held_for_me: heldFor(allocations, lineId),
    incoming_for_me: incomingFor(allocations, lineId),
    my_open_need: myOpen,
    others_open_need: othersOpen,
    net,
    short: Math.max(0, -net),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -w server
```

Expected: all pass, including `PROPERTY: with no allocations, the new engine equals the old formula`.

- [ ] **Step 5: Commit**

```bash
git add server/src/board-allocation.js server/src/board-allocation.test.js
git commit -m "feat(board): pure allocation position math with equivalence property test"
```

---

## Task 4: Planning a move

Still pure, still no database. This produces the exact "what will happen" list the confirm dialog renders, so the dialog cannot describe something different from what the commit does.

**Files:**
- Modify: `server/src/board-allocation.js`
- Modify: `server/src/board-allocation.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `server/src/board-allocation.test.js`:

```js
import { planMove, movableFrom, holdableFor } from './board-allocation.js';

const MOVE_LINES = [
  { id: 1, parent_sheets_required: 41742, product_name: 'ACEBROBID AC TABLET' },
  { id: 2, parent_sheets_required: 20000, product_name: 'NICOSTAR 10 TAB' },
];
const ACEBROBID_PR = { id: 6, pr_number: 'CI-PR-0006', qty: 41742, status: 'pending', order_line_id: 1 };

function baseMove(over = {}) {
  return {
    materialId: 7,
    fromLineId: 2,
    toLineId: 1,
    qty: 20000,
    available: 26000,
    allocations: [{ order_line_id: 1, qty: 41742, source: 'requisition', status: 'active', requisition_id: 6 }],
    lines: MOVE_LINES,
    openPrs: [ACEBROBID_PR],
    ...over,
  };
}

test('movableFrom: a job can give up what it holds plus its share of free stock', () => {
  assert.equal(movableFrom({ line: MOVE_LINES[1], available: 26000, allocations: [] }), 20000);
});

test('movableFrom: capped by free stock when the board is not actually there', () => {
  assert.equal(movableFrom({ line: MOVE_LINES[1], available: 5000, allocations: [] }), 5000);
});

test('holdableFor: a job cannot be held more board than it needs', () => {
  assert.equal(holdableFor({ line: MOVE_LINES[0], allocations: [] }), 41742);
});

test('holdableFor: already-ordered board does NOT reduce the cap — cancelling that PR is the point', () => {
  const allocations = [{ order_line_id: 1, qty: 41742, source: 'requisition', status: 'active' }];
  assert.equal(holdableFor({ line: MOVE_LINES[0], allocations }), 41742);
});

test('holdableFor: existing holds DO reduce the cap', () => {
  const allocations = [{ order_line_id: 1, qty: 36742, source: 'stock', status: 'active' }];
  assert.equal(holdableFor({ line: MOVE_LINES[0], allocations }), 5000);
});

test('planMove: the happy path spells out all three consequences', () => {
  const plan = planMove(baseMove());
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.net_purchase_delta, 0);

  const kinds = plan.effects.map(e => e.kind);
  assert.deepEqual(kinds, ['hold', 'pr_down', 'pr_new']);
  assert.match(plan.effects[0].text, /ACEBROBID AC TABLET takes 20,000 sheets/);
  assert.match(plan.effects[1].text, /CI-PR-0006 drops 41,742 → 21,742/);
  assert.equal(plan.effects[1].requisition_id, 6);
  assert.equal(plan.effects[1].new_qty, 21742);
  assert.match(plan.effects[2].text, /NICOSTAR 10 TAB gets a new PR for 20,000/);
  assert.equal(plan.effects[2].qty, 20000);
});

test('planMove: a PR reduced to zero is closed, not left at zero', () => {
  const plan = planMove(baseMove({
    qty: 41742,
    available: 60000,
    lines: [MOVE_LINES[0], { id: 2, parent_sheets_required: 41742, product_name: 'NICOSTAR 10 TAB' }],
  }));
  assert.equal(plan.ok, true);
  const down = plan.effects.find(e => e.kind === 'pr_down');
  assert.equal(down.new_qty, 0);
  assert.equal(down.close, true);
  assert.match(down.text, /CI-PR-0006 is fully covered from stock and closes/);
});

test('planMove: conservation holds for every legal quantity', () => {
  for (const qty of [1, 500, 10000, 19999, 20000]) {
    const plan = planMove(baseMove({ qty }));
    assert.equal(plan.ok, true, `qty ${qty} should be legal`);
    assert.equal(plan.net_purchase_delta, 0, `qty ${qty} changed net purchase`);
  }
});

test('planMove: taking more than the source job has is blocked, not clamped', () => {
  const plan = planMove(baseMove({ qty: 25000 }));
  assert.equal(plan.ok, false);
  assert.match(plan.blockers[0], /NICOSTAR 10 TAB only has 20,000/);
});

test('planMove: holding a job more than it needs is blocked', () => {
  const plan = planMove(baseMove({
    qty: 20000,
    lines: [{ id: 1, parent_sheets_required: 5000, product_name: 'ACEBROBID AC TABLET' }, MOVE_LINES[1]],
    allocations: [],
    openPrs: [{ ...ACEBROBID_PR, qty: 5000 }],
  }));
  assert.equal(plan.ok, false);
  assert.match(plan.blockers[0], /ACEBROBID AC TABLET only needs 5,000/);
});

test('planMove: zero, negative and same-job moves are rejected', () => {
  assert.match(planMove(baseMove({ qty: 0 })).blockers[0], /greater than zero/);
  assert.match(planMove(baseMove({ qty: -5 })).blockers[0], /greater than zero/);
  assert.match(planMove(baseMove({ toLineId: 2 })).blockers[0], /same job/);
});

test('planMove: a gang member cannot be moved', () => {
  const plan = planMove(baseMove({
    lines: [MOVE_LINES[0], { ...MOVE_LINES[1], gang_run_id: 12, gang_number: 'CI-G-0012' }],
  }));
  assert.equal(plan.ok, false);
  assert.match(plan.blockers[0], /CI-G-0012/);
});

test('planMove: oldest PR is reduced first when the target has several', () => {
  const plan = planMove(baseMove({
    qty: 20000,
    openPrs: [
      { id: 6, pr_number: 'CI-PR-0006', qty: 15000, status: 'pending', order_line_id: 1 },
      { id: 9, pr_number: 'CI-PR-0009', qty: 26742, status: 'approved', order_line_id: 1 },
    ],
  }));
  assert.equal(plan.ok, true);
  const downs = plan.effects.filter(e => e.kind === 'pr_down');
  assert.equal(downs.length, 2);
  assert.equal(downs[0].requisition_id, 6);
  assert.equal(downs[0].new_qty, 0);
  assert.equal(downs[0].close, true);
  assert.equal(downs[1].requisition_id, 9);
  assert.equal(downs[1].new_qty, 21742);
  assert.equal(plan.net_purchase_delta, 0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -w server
```

Expected: FAIL — `planMove is not a function` (or an import error).

- [ ] **Step 3: Implement move planning**

Append to `server/src/board-allocation.js`:

```js
const fmt = n => Math.round(n).toLocaleString('en-IN');

// The most a job can give up: what it explicitly holds, plus however much of
// the free pool it is currently relying on. Never more than it actually claims —
// otherwise you would be taking a THIRD job's share while blaming this one.
export function movableFrom({ line, available, allocations = [] }) {
  const { free } = boardPosition({ available, allocations });
  const held = heldFor(allocations, line.id);
  const claim = Math.max(0, lineNeed(line) - incomingFor(allocations, line.id));
  return Math.max(0, Math.min(held + free, claim));
}

// The most a job can be held. Deliberately does NOT subtract incoming PR
// quantity: cancelling that PR is the entire point of moving stock to this job.
export function holdableFor({ line, allocations = [] }) {
  return Math.max(0, lineNeed(line) - heldFor(allocations, line.id));
}

// Work out every consequence of a proposed move. Returns the exact list the
// confirm dialog renders, so the preview cannot drift from the commit.
export function planMove({ materialId, fromLineId, toLineId, qty, available, allocations = [], lines = [], openPrs = [] }) {
  const blockers = [];
  const from = lines.find(l => l.id === fromLineId);
  const to = lines.find(l => l.id === toLineId);
  const q = Number(qty);

  if (!from) blockers.push('The job giving up the board is no longer planned.');
  if (!to) blockers.push('The job receiving the board is no longer planned.');
  if (!(q > 0)) blockers.push('Enter a number of sheets greater than zero.');
  if (fromLineId === toLineId) blockers.push('That is the same job — pick a different one.');

  // A gang shares one board across several jobs and buys it with a single
  // combined PR. Unpicking one member mid-move is out of scope; say so plainly.
  for (const l of [from, to]) {
    if (l?.gang_run_id)
      blockers.push(`${l.product_name} prints in gang ${l.gang_number || `#${l.gang_run_id}`} — move the gang's board from Planning.`);
  }

  if (blockers.length) return { ok: false, blockers, effects: [], net_purchase_delta: 0, qty: q };

  const canGive = movableFrom({ line: from, available, allocations });
  const canTake = holdableFor({ line: to, allocations });
  if (q > canGive)
    blockers.push(`${from.product_name} only has ${fmt(canGive)} sheets to give.`);
  if (q > canTake)
    blockers.push(`${to.product_name} only needs ${fmt(canTake)} more sheets.`);

  if (blockers.length) return { ok: false, blockers, effects: [], net_purchase_delta: 0, qty: q };

  const effects = [{
    kind: 'hold',
    order_line_id: to.id,
    qty: q,
    text: `${to.product_name} takes ${fmt(q)} sheets from the warehouse`,
  }];

  // Reduce the receiving job's open PRs, oldest first. holdableFor guarantees
  // the mirrored PRs total at least q, so the loop always absorbs the full
  // quantity and net purchase lands on exactly zero.
  let toAbsorb = q;
  let reduced = 0;
  for (const pr of [...openPrs].filter(p => p.order_line_id === to.id).sort((a, b) => a.id - b.id)) {
    if (toAbsorb <= 0) break;
    const cut = Math.min(num(pr.qty), toAbsorb);
    const newQty = num(pr.qty) - cut;
    effects.push({
      kind: 'pr_down',
      requisition_id: pr.id,
      pr_number: pr.pr_number,
      new_qty: newQty,
      close: newQty === 0,
      text: newQty === 0
        ? `${pr.pr_number} is fully covered from stock and closes`
        : `${pr.pr_number} drops ${fmt(pr.qty)} → ${fmt(newQty)}`,
    });
    toAbsorb -= cut;
    reduced += cut;
  }

  effects.push({
    kind: 'pr_new',
    order_line_id: from.id,
    material_id: materialId,
    qty: q,
    text: `${from.product_name} gets a new PR for ${fmt(q)} sheets`,
  });

  return { ok: true, blockers: [], effects, qty: q, net_purchase_delta: q - reduced };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -w server
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/board-allocation.js server/src/board-allocation.test.js
git commit -m "feat(board): move planning with conservation and cap guards"
```

---

## Task 5: The table

Follows `DEPLOYMENT.md` §3. Read it before starting.

**Files:**
- Modify: `server/src/db.js` (inside `init()`, at the end near `board_rates`)
- Create: `supabase/migrations/0005_board_allocations.sql`
- Regenerate: `supabase/migrations/0001_baseline_schema.sql`

- [ ] **Step 1: Add the table to init()**

In `server/src/db.js`, inside the final `await pool.query(...)` block that defines `board_rates` (around line 1485), append after the covering-index section:

```sql
-- Board allocation --------------------------------------------------------
-- Until now "committed" was a live SUM over planned order lines — nobody could
-- HOLD board, so whichever job reached cutting first consumed the pile. A row
-- here is an explicit claim: N parent sheets of this board are earmarked for
-- this job, either from warehouse stock or from an incoming requisition.
-- board-allocation.js turns these rows into the planning engine's numbers; with
-- no rows it returns exactly what the old formula returned.
CREATE TABLE IF NOT EXISTS board_allocations (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  material_id     INTEGER NOT NULL REFERENCES materials(id),
  order_line_id   INTEGER NOT NULL REFERENCES order_lines(id) ON DELETE CASCADE,
  qty             DOUBLE PRECISION NOT NULL CHECK (qty > 0),
  source          TEXT NOT NULL CHECK (source IN ('stock','requisition')),
  requisition_id  INTEGER REFERENCES requisitions(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','released','consumed')),
  reason          TEXT,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_by     TEXT,
  released_at     TIMESTAMPTZ,
  release_reason  TEXT
);
CREATE INDEX IF NOT EXISTS idx_alloc_material_active
  ON board_allocations (material_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_fk_board_allocations_order_line_id
  ON board_allocations (order_line_id);
CREATE INDEX IF NOT EXISTS idx_fk_board_allocations_requisition_id
  ON board_allocations (requisition_id);
```

Placement matters: this must sit **after** `materials`, `order_lines` and `requisitions` are created. The end of `init()` satisfies that. A prior bug in this file put six `ALTER TABLE tools` statements before `CREATE TABLE tools`, which crashed any database built from empty — step 4 is what catches that class of mistake.

- [ ] **Step 2: Regenerate the baseline**

```bash
npm run db:baseline
```

Expected: `supabase/migrations/0001_baseline_schema.sql` is rewritten and now contains `board_allocations`.

- [ ] **Step 3: Write the named production migration**

Create `supabase/migrations/0005_board_allocations.sql` with the same SQL as Step 1 (the `CREATE TABLE` plus all three indexes). Migrations 0002–0004 are already applied; this is the next number.

- [ ] **Step 4: Prove the baseline replays into an empty database**

```bash
npm run db:check -- --baseline
```

Expected: success. A failure here means ordering is wrong — fix the placement, do not work around it.

- [ ] **Step 5: Confirm the table exists locally**

```bash
psql "postgresql://postgres:postgres@localhost:5439/cierp" -c "\d board_allocations"
```

Expected: the table with all 13 columns. If it is missing, restart the server — `init()` runs on startup in local development only.

- [ ] **Step 6: Commit**

```bash
git add server/src/db.js supabase/migrations/0001_baseline_schema.sql supabase/migrations/0005_board_allocations.sql
git commit -m "feat(db): board_allocations table"
```

---

## Task 6: PR and allocation stay mirrored

The rule that stops the losing job reading "short" straight after a move: an open PR carrying an `order_line_id` always has a matching `source='requisition'` allocation.

**Files:**
- Modify: `server/src/routes/procurement.js`

- [ ] **Step 1: Add the mirror helper**

Near the top of `server/src/routes/procurement.js`, after the existing imports:

```js
// An open PR that names an order line ALWAYS has a matching requisition-source
// allocation of the same quantity. This is what lets the planning engine see an
// incoming PR as coverage — without it, a job whose PR was just raised would
// still read "short", which is the single most confusing outcome this feature
// could produce. Called on every transition that changes a PR's life or size.
async function syncPrAllocation(qc, pr, { close = false } = {}) {
  if (!pr?.order_line_id) return;
  const mat = await qc(`SELECT category FROM materials WHERE id=$1`, [pr.material_id]);
  if (mat[0]?.category !== 'board') return;

  await qc(`UPDATE board_allocations SET status='released', released_at=now()
            WHERE requisition_id=$1 AND status='active'`, [pr.id]);
  const open = !close && ['pending', 'approved', 'converted'].includes(pr.status) && Number(pr.qty) > 0;
  if (!open) return;

  await qc(`INSERT INTO board_allocations
              (material_id, order_line_id, qty, source, requisition_id, reason, created_by)
            VALUES ($1,$2,$3,'requisition',$4,$5,$6)`,
    [pr.material_id, pr.order_line_id, pr.qty, pr.id,
     `Incoming on ${pr.pr_number}`, pr.requested_by || null]);
}
```

- [ ] **Step 2: Call it from every PR transition**

Add `await syncPrAllocation(qc, pr);` inside the transaction of each of these, immediately before the existing `audit(...)` call:

| Route | Location | Call |
|---|---|---|
| `POST /requisitions` | after `insertReqLines` | `await syncPrAllocation(qc, pr);` |
| `PUT /requisitions/:id` | after the `UPDATE ... RETURNING *` | `await syncPrAllocation(qc, row);` |
| `POST /requisitions/:id/close` | after the status update | `await syncPrAllocation(qc, { ...pr, status: 'closed' }, { close: true });` |
| `POST /requisitions/:id/reject` | after the status update | `await syncPrAllocation(qc, { ...pr, status: 'rejected' }, { close: true });` |
| `DELETE /requisitions/:id` | before the `DELETE FROM requisitions` | `await syncPrAllocation(qc, pr, { close: true });` |

`POST /requisitions/:id/close` and `/reject` currently run outside a transaction using `q`. Wrap each in `tx(async (qc, oc) => { ... })` so the status change and the allocation release cannot land apart. Follow the shape already used by `DELETE /requisitions/:id`.

Conversion to a PO deliberately does **not** release the allocation — the material is still incoming.

- [ ] **Step 3: Retire the allocation when the board actually arrives**

Without this the job is credited twice for the same board — once through `available` when the stock lands, and again through its still-active `requisition` allocation. The error is permanent and compounds with every received board PR.

`POST /grns/:id/qc` (`server/src/routes/procurement.js:840`) is the moment board becomes real stock: on accept, the batch flips to `available` and `po_lines.received_qty` rises. Reduce the requisition's allocation by the same quantity there.

In the `if (accept)` branch, immediately after the `po_lines` / `purchase_orders` status block:

```js
        // The board is now real stock counted in `available`. Its requisition
        // allocation must shrink by the same amount or the job is credited
        // twice — once as stock on hand, once as still incoming.
        if (g.purchase_order_id) {
          const alloc = await qc(
            `SELECT a.id, a.qty FROM board_allocations a
             JOIN requisitions rq ON rq.id = a.requisition_id
             WHERE a.status='active' AND a.source='requisition'
               AND a.material_id=$1 AND rq.purchase_order_id=$2
             ORDER BY a.id`, [g.material_id, g.purchase_order_id]);
          let landed = Number(g.qty);
          for (const a of alloc) {
            if (landed <= 0) break;
            const cut = Math.min(Number(a.qty), landed);
            const left = Number(a.qty) - cut;
            if (left > 0) await qc('UPDATE board_allocations SET qty=$1 WHERE id=$2', [left, a.id]);
            else await qc(`UPDATE board_allocations SET status='consumed', released_at=now() WHERE id=$1`, [a.id]);
            landed -= cut;
          }
        }
```

Reducing rather than releasing matters for a partial GRN: 20,000 ordered, 12,000 delivered leaves 8,000 genuinely still incoming.

- [ ] **Step 4: Verify the double-count is gone**

With a board that has an open PR linked to a job, record the job's position, then receive and QC-accept a GRN against that PR's PO. The job's `short` must not move — the board simply changed from *incoming* to *on hand*.

```bash
psql "postgresql://postgres:postgres@localhost:5439/cierp" -c \
  "SELECT a.id, a.qty, a.status, a.source, r.pr_number
   FROM board_allocations a LEFT JOIN requisitions r ON r.id=a.requisition_id
   WHERE a.source='requisition' ORDER BY a.id DESC LIMIT 5;"
```

Expected: the allocation is reduced by the received quantity, or `consumed` if fully received.

- [ ] **Step 5: Verify against the running app**

Restart the server, then in the UI raise a PR from the Planning Engine for a short board and check:

```bash
psql "postgresql://postgres:postgres@localhost:5439/cierp" -c \
  "SELECT a.id, a.order_line_id, a.qty, a.source, a.status, r.pr_number
   FROM board_allocations a JOIN requisitions r ON r.id=a.requisition_id
   ORDER BY a.id DESC LIMIT 3;"
```

Expected: one active `requisition` row matching the PR's quantity. Now close that PR in the UI and re-run the query — expected: `status` is `released`.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/procurement.js
git commit -m "feat(procurement): mirror requisition allocations across PR lifecycle"
```

---

## Task 7: The panel endpoint

**Files:**
- Create: `server/src/routes/board.js`
- Modify: `server/src/app.js`

- [ ] **Step 1: Write the router**

Create `server/src/routes/board.js`:

```js
// Board allocation — who is holding this board, and moving that hold between
// jobs. All arithmetic lives in board-allocation.js; this file only loads rows,
// hands them over, and writes the result down.
import { Router } from 'express';
import { q, one, tx } from '../db.js';
import { audit, nextNumber, EFF_BOARD_ID } from '../helpers.js';
import { requireRole } from '../auth.js';
import { boardPosition, linePosition, planMove, movableFrom, holdableFor, lineNeed } from '../board-allocation.js';

const r = Router();
const canMove = requireRole('planner');

// Every planned/ready line competing for this board, plus its gang identity so
// the client can group and lock gang rows exactly as the rest of the app does.
async function linesFor(materialId, qc = q) {
  return qc(`
    SELECT ol.id, ol.status, ol.planned_date, ol.gang_run_id,
           COALESCE(ol.parent_sheets_required, ol.sheets_required) AS parent_sheets_required,
           ol.sheets_required,
           p.id AS product_id, p.name AS product_name, p.code AS product_code,
           p.party_artwork_code,
           o.po_number, o.delivery_date, c.name AS customer_name,
           g.gang_number
    FROM order_lines ol
    JOIN products  p ON p.id = ol.product_id
    JOIN orders    o ON o.id = ol.order_id
    JOIN customers c ON c.id = o.customer_id
    LEFT JOIN gang_runs g ON g.id = ol.gang_run_id
    WHERE ${EFF_BOARD_ID} = $1 AND ol.status IN ('planned','ready')
    ORDER BY ol.planned_date NULLS LAST, o.delivery_date, ol.id`, [materialId]);
}

async function allocationsFor(materialId, qc = q) {
  return qc(`SELECT * FROM board_allocations WHERE material_id=$1 AND status='active' ORDER BY id`, [materialId]);
}

async function openPrsFor(materialId, qc = q) {
  return qc(`SELECT id, pr_number, qty, status, order_line_id, needed_by
             FROM requisitions
             WHERE material_id=$1 AND status IN ('pending','approved') ORDER BY id`, [materialId]);
}

async function availableFor(materialId, qc = q) {
  const [row] = await qc(
    `SELECT COALESCE(SUM(qty),0) AS q FROM stock_batches WHERE material_id=$1 AND status='available'`,
    [materialId]);
  return Number(row.q);
}

// Everything the panel renders, in one call.
r.get('/board/:materialId/panel', async (req, res, next) => {
  try {
    const materialId = +req.params.materialId;
    const board = await one('SELECT id, name, spec, category, grade, gsm, sheet_l, sheet_w FROM materials WHERE id=$1', [materialId]);
    if (!board) return res.status(404).json({ error: 'Board not found' });

    const [available, lines, allocations, openPrs] = await Promise.all([
      availableFor(materialId), linesFor(materialId), allocationsFor(materialId), openPrsFor(materialId),
    ]);

    const position = boardPosition({ available, allocations });
    const prByLine = {};
    for (const pr of openPrs) if (pr.order_line_id) (prByLine[pr.order_line_id] ||= []).push(pr);

    res.json({
      board,
      ...position,
      lines: lines.map(l => ({
        ...l,
        need: lineNeed(l),
        held: allocations.filter(a => a.source === 'stock' && a.order_line_id === l.id)
          .reduce((s, a) => s + Number(a.qty), 0),
        incoming: allocations.filter(a => a.source === 'requisition' && a.order_line_id === l.id)
          .reduce((s, a) => s + Number(a.qty), 0),
        movable: movableFrom({ line: l, available, allocations }),
        holdable: holdableFor({ line: l, allocations }),
        prs: prByLine[l.id] || [],
      })),
      unlinked_prs: openPrs.filter(pr => !pr.order_line_id),
    });
  } catch (e) { next(e); }
});

// Position for one line — the planning engine's numbers, from the same math.
//
// The line being planned is resolved SEPARATELY and without a status filter. It
// is usually still 'pending' — orders.js:1005 only flips it to 'planned' at the
// END of the plan-save — so it is NOT in linesFor()'s planned/ready set. Passing
// it as `line` and the rest as `others` mirrors the `AND ol.id != $2` that has
// been correct in production for months. linePosition throws when `line` is
// missing rather than silently treating the planner's own requirement as zero.
r.get('/board/:materialId/position/:lineId', async (req, res, next) => {
  try {
    const materialId = +req.params.materialId;
    const lineId = +req.params.lineId;
    const [available, lines, allocations] = await Promise.all([
      availableFor(materialId), linesFor(materialId), allocationsFor(materialId),
    ]);
    const line = lines.find(l => l.id === lineId) || await one(`
      SELECT ol.id, ol.sheets_required,
             COALESCE(ol.parent_sheets_required, ol.sheets_required) AS parent_sheets_required
      FROM order_lines ol WHERE ol.id=$1`, [lineId]);
    if (!line) return res.status(404).json({ error: 'Order line not found' });
    res.json(linePosition({
      line, others: lines.filter(l => l.id !== lineId), available, allocations, materialId,
    }));
  } catch (e) { next(e); }
});

export { linesFor, allocationsFor, openPrsFor, availableFor };
export default r;
```

- [ ] **Step 2: Mount the router**

In `server/src/app.js`, add the import beside the others:

```js
import board from './routes/board.js';
```

and mount it beside the others (order does not matter — the paths do not collide):

```js
app.use('/api', board);
```

- [ ] **Step 3: Verify the endpoint answers**

Restart the server. Get a token and call it (replace `7` with a real board material id):

```bash
TOKEN=$(curl -sS -X POST localhost:4000/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@motionci.com","password":"admin123"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
curl -sS localhost:4000/api/board/7/panel -H "Authorization: Bearer $TOKEN" | python3 -m json.tool | head -40
```

Expected: JSON with `available`, `held`, `free`, and a `lines` array.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/board.js server/src/app.js
git commit -m "feat(board): panel and position endpoints"
```

---

## Task 8: The planning engine uses the new math

Swap the planning context onto `linePosition` so Planning, Procurement and Masters cannot disagree.

**Files:**
- Modify: `server/src/routes/orders.js:1037-1041` and the `res.json` block around `:1102`

- [ ] **Step 1: Replace the committed query with the allocation-aware position**

In `server/src/routes/orders.js`, in `GET /planning/:lineId/context`, replace the `committed` query with:

```js
    // `otherLines` deliberately excludes this line with `ol.id != $2`, exactly as
    // the committed query it replaces did. The line being planned is usually
    // still 'pending' at this point — orders.js:1005 only flips it to 'planned'
    // at the end of the plan-save — so it must NOT be looked up inside a
    // planned/ready set. It is passed explicitly as `line`, taken from LINE_VIEW
    // which carries no status filter.
    const [allocations, otherLines] = await Promise.all([
      q(`SELECT * FROM board_allocations WHERE material_id=$1 AND status='active'`, [matId]),
      q(`SELECT ol.id, ol.sheets_required,
                COALESCE(ol.parent_sheets_required, ol.sheets_required) AS parent_sheets_required
         FROM order_lines ol JOIN products p ON p.id=ol.product_id
         WHERE ${EFF_BOARD_ID}=$1 AND ol.status IN ('planned','ready')
           AND ol.id != $2`, [matId, line.id]),
    ]);
    const position = linePosition({
      line, others: otherLines, available: Number(stock.available), allocations, materialId: matId,
    });
```

`line` here is the row from `LINE_VIEW` already loaded at the top of this handler. It carries `parent_sheets_required` and `sheets_required`, which is all `lineNeed()` reads.

Add the import at the top of the file:

```js
import { linePosition } from '../board-allocation.js';
```

- [ ] **Step 2: Extend the response without breaking the existing client**

Change the `stock` key in the `res.json({ ... })` block from:

```js
      stock: { ...stock, committed_other: committed.sheets },
```

to:

```js
      // committed_other is kept for the existing client math; held/free/short
      // are the allocation-aware view. With no allocations the two agree.
      stock: {
        ...stock,
        committed_other: position.others_open_need,
        held: position.held,
        held_for_me: position.held_for_me,
        incoming_for_me: position.incoming_for_me,
        free: position.free,
        net: position.net,
        short: position.short,
      },
```

- [ ] **Step 3: Verify the numbers did not move**

With no allocations yet on a board, open the Planning Engine on a line using it and compare Available / Committed / Net After Plan against what the screen showed before this task. They must be identical.

```bash
npm test -w server
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/orders.js
git commit -m "feat(planning): allocation-aware board position in planning context"
```

---

## Task 9: The panel, read-only

Ship the information before the actions. After this task the plant sees more and behaves identically.

**Files:**
- Create: `client/src/components/BoardCommitments.jsx`
- Modify: `client/src/pages/Procurement.jsx:613-618`

- [ ] **Step 1: Build the panel component**

Create `client/src/components/BoardCommitments.jsx`:

```jsx
// The one place that explains a board: what the warehouse has, how much of it is
// held, and which jobs are waiting. Rendered from Procurement (a PR row), the
// Planning Engine (a short banner) and Masters 360, so the three can never show
// different numbers. `prContext` is the requisition the panel was opened from,
// when there is one — it gets its own highlighted block at the top.
import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { api, fmt } from '../api.js';
import { Button, Field, Input, Modal, Select, useToast } from './ui.jsx';

function Tile({ label, value, accent = 'text-slate-900' }) {
  return (
    <div className="rounded-xl bg-slate-50/80 px-3 py-2.5">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</div>
      <div className={`mt-0.5 text-xl font-bold tabular-nums ${accent}`}>{value}</div>
    </div>
  );
}

export default function BoardCommitments({ open, onClose, materialId, prContext = null, onChanged }) {
  const [data, setData] = useState(null);
  const toast = useToast();

  const load = async () => {
    if (!materialId) return;
    try { setData(await api.get(`/board/${materialId}/panel`)); }
    catch { toast.error('Could not load the board position'); }
  };
  useEffect(() => { if (open) load(); }, [open, materialId]);

  const targetLineId = prContext?.order_line_id || null;
  const target = data?.lines.find(l => l.id === targetLineId) || null;

  return (
    <Modal open={open} onClose={onClose} wide
      title={data?.board?.name || 'Board position'}>
      {!data ? <p className="py-6 text-center text-sm text-slate-400">Loading…</p> : (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-2.5">
            <Tile label="In warehouse" value={fmt.num(data.available)} />
            <Tile label="Committed" value={fmt.num(data.held)} accent={data.held > 0 ? 'text-amber-600' : 'text-slate-900'} />
            <Tile label="Free" value={fmt.num(data.free)} accent={data.free > 0 ? 'text-emerald-600' : 'text-red-600'} />
          </div>

          {prContext && (
            <div className="rounded-xl border border-brand-200 bg-brand-50/70 px-3.5 py-3">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-brand-500">
                {prContext.pr_number} is buying for
              </div>
              {target ? (
                <>
                  <div className="mt-1 text-sm font-semibold text-brand-800">{target.product_name}</div>
                  <div className="text-xs text-brand-600">
                    PO {target.po_number} · needs {fmt.num(target.need)} · from stock {fmt.num(target.held)} · buying {fmt.num(target.incoming)}
                  </div>
                </>
              ) : (
                <p className="mt-1 flex items-start gap-2 text-xs font-semibold text-amber-700">
                  <AlertTriangle size={14} className="mt-px shrink-0" />
                  This requisition was raised before jobs were linked to PRs, so it does not name a job yet.
                </p>
              )}
            </div>
          )}

          <div>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              The board in the warehouse is committed to
            </div>
            {data.lines.length === 0 ? (
              <p className="rounded-xl bg-slate-50 px-3 py-4 text-center text-sm text-slate-400">
                Nothing is planned on this board — all {fmt.num(data.available)} sheets are free.
              </p>
            ) : data.lines.map(l => (
              <div key={l.id} className="flex items-center gap-3 border-b border-slate-100 py-2.5 last:border-0">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-slate-800">
                    {l.product_name}
                    {l.gang_run_id && (
                      <span className="ml-1.5 rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] font-bold text-violet-700">
                        {l.gang_number || `gang #${l.gang_run_id}`}
                      </span>
                    )}
                  </div>
                  <div className="truncate text-[11px] text-slate-400">
                    PO {l.po_number} · {l.customer_name}
                    {l.planned_date ? ` · planned ${fmt.date(l.planned_date)}` : ''}
                  </div>
                </div>
                <div className="text-right text-sm font-semibold tabular-nums text-slate-700">
                  {fmt.num(l.need)}
                  {l.held > 0 && <div className="text-[11px] font-normal text-amber-600">{fmt.num(l.held)} held</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}
```

- [ ] **Step 2: Add the stock line to the PR row**

In `client/src/pages/Procurement.jsx`, add state near the other modal state:

```jsx
  const [boardPanel, setBoardPanel] = useState(null);
```

Replace the `Items` column renderer (currently at `:613-618`) with:

```jsx
            { key: 'material_name', label: 'Items', render: p => {
              const ls = p.lines || [];
              const first = ls[0]?.material_name || p.material_name;
              const matId = ls.length === 1 ? (ls[0]?.material_id || p.material_id) : null;
              const stk = p.board_stock;
              return (<div>{first}{ls.length > 1 && <span className="ml-1 rounded-full bg-brand-50 px-1.5 py-0.5 text-[10px] font-bold text-brand-600">+{ls.length - 1} more</span>}
                <div className="text-[11px] capitalize text-slate-400">{ls.length > 1 ? `${ls.length} items` : (ls[0]?.material_category || p.material_category)}</div>
                {matId && stk && (
                  <button type="button"
                    onClick={e => { e.stopPropagation(); setBoardPanel({ materialId: matId, pr: p }); }}
                    className={`mt-1.5 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                      stk.free > 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
                    <Package size={12} />
                    {fmt.num(stk.available)} in warehouse
                    {stk.available > 0 && (stk.free > 0
                      ? ` · ${fmt.num(stk.free)} free`
                      : ` · all of it committed to ${stk.jobs} job${stk.jobs === 1 ? '' : 's'}`)}
                  </button>
                )}
              </div>);
            } },
```

Import `Package` from `lucide-react` alongside the existing icon imports, and import the panel:

```jsx
import BoardCommitments from '../components/BoardCommitments.jsx';
```

Render it once, beside the other modals at the bottom of the component:

```jsx
      <BoardCommitments
        open={!!boardPanel}
        onClose={() => setBoardPanel(null)}
        materialId={boardPanel?.materialId}
        prContext={boardPanel?.pr}
        onChanged={load} />
```

- [ ] **Step 3: Serve `board_stock` on the requisition list**

In `server/src/routes/procurement.js`, in the handler for `GET /requisitions`, attach a compact stock summary for single-line board PRs. After the rows are fetched and before `res.json`:

```js
    // Live warehouse position for single-material board PRs, so the register
    // shows what is already on hand next to what is being bought.
    const boardIds = [...new Set(rows
      .filter(p => (p.lines || []).length <= 1 && p.material_category === 'board')
      .map(p => p.material_id).filter(Boolean))];
    const stk = {};
    if (boardIds.length) {
      const avail = await q(`SELECT material_id, COALESCE(SUM(qty),0) AS q FROM stock_batches
                             WHERE status='available' AND material_id=ANY($1::int[]) GROUP BY 1`, [boardIds]);
      const held = await q(`SELECT material_id, COALESCE(SUM(qty),0) AS q FROM board_allocations
                            WHERE status='active' AND source='stock' AND material_id=ANY($1::int[]) GROUP BY 1`, [boardIds]);
      const jobs = await q(`SELECT ${EFF_BOARD_ID} AS material_id, COUNT(*)::int AS n
                            FROM order_lines ol JOIN products p ON p.id=ol.product_id
                            WHERE ol.status IN ('planned','ready') AND ${EFF_BOARD_ID}=ANY($1::int[])
                            GROUP BY 1`, [boardIds]);
      const m = (arr, k) => Object.fromEntries(arr.map(x => [x.material_id, Number(x[k])]));
      const a = m(avail, 'q'), h = m(held, 'q'), j = m(jobs, 'n');
      for (const id of boardIds)
        stk[id] = { available: a[id] || 0, held: h[id] || 0, free: (a[id] || 0) - (h[id] || 0), jobs: j[id] || 0 };
    }
    res.json(rows.map(p => ({ ...p, board_stock: stk[p.material_id] || null })));
```

Add `EFF_BOARD_ID` to the `../helpers.js` import in this file.

- [ ] **Step 4: Give Masters 360 the same split**

`GET /inventory/demand/:materialId` (`server/src/routes/inventory.js:52`) already feeds the Committed / Available / Shortfall block in the Masters 360 drawer. Extend it rather than replacing it, so the existing drawer keeps working.

In `server/src/routes/inventory.js`, after the `available` query and before `res.json`:

```js
    const [{ q: heldQ }] = await q(
      `SELECT COALESCE(SUM(qty),0) AS q FROM board_allocations
       WHERE material_id=$1 AND status='active' AND source='stock'`, [materialId]);
    const held = Number(heldQ);
```

and extend the response object:

```js
    res.json({
      material_id: materialId,
      total_sheets,
      available: Number(available),
      held,
      free: Number(available) - held,
      shortfall: Math.max(0, total_sheets - Number(available)),
      lines,
    });
```

In `client/src/components/MasterHistory.jsx`, add `Held` and `Free` beside the existing Shortfall stat at `:543`, following the same `<span>` shape already there:

```jsx
                      <span>Held <b className={`tabular-nums ${+demand?.held > 0 ? 'font-bold text-amber-700' : 'text-slate-500'}`}>{fmt.num(demand?.held)}</b></span>
                      <span>Free <b className={`tabular-nums ${+demand?.free > 0 ? 'text-emerald-700' : 'text-red-600'}`}>{fmt.num(demand?.free)}</b></span>
```

- [ ] **Step 5: Verify in the running app**

Restart the server, hard-reload the client, log in at a desktop width, open Procurement → Requisitions. Each single-line board PR must show the warehouse chip under the item name. Click it — the panel opens with the three tiles and the committed job list. Confirm the tile numbers match:

```bash
psql "postgresql://postgres:postgres@localhost:5439/cierp" -c \
  "SELECT COALESCE(SUM(qty),0) FROM stock_batches WHERE material_id=<id> AND status='available';"
```

Then open Masters → a board → the 360° drawer and confirm Held and Free appear and agree with the panel.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/BoardCommitments.jsx client/src/pages/Procurement.jsx \
        server/src/routes/procurement.js server/src/routes/inventory.js \
        client/src/components/MasterHistory.jsx
git commit -m "feat(procurement): live board stock on PR rows with commitments panel"
```

---

## Task 10: The move

**Files:**
- Modify: `server/src/routes/board.js`

- [ ] **Step 1: Add preview and commit endpoints**

Append to `server/src/routes/board.js`, before the exports:

```js
// Load everything planMove needs, inside whatever transaction the caller owns.
async function moveInputs(materialId, qc) {
  const [available, lines, allocations, openPrs] = await Promise.all([
    availableFor(materialId, qc), linesFor(materialId, qc),
    allocationsFor(materialId, qc), openPrsFor(materialId, qc),
  ]);
  return { available, lines, allocations, openPrs };
}

r.post('/board/move/preview', canMove, async (req, res, next) => {
  try {
    const { material_id, from_order_line_id, to_order_line_id, qty } = req.body;
    const inputs = await moveInputs(+material_id, q);
    res.json(planMove({
      materialId: +material_id,
      fromLineId: +from_order_line_id,
      toLineId: +to_order_line_id,
      qty: +qty,
      ...inputs,
    }));
  } catch (e) { next(e); }
});

r.post('/board/move', canMove, async (req, res, next) => {
  try {
    const { material_id, from_order_line_id, to_order_line_id, qty } = req.body;
    const reason = String(req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'A reason is required to move board between jobs' });

    // Allocations are a board concept. Inks and consumables have no order-line
    // demand competing over them, so there is nothing to reshuffle.
    const mat = await one('SELECT category, name FROM materials WHERE id=$1', [+material_id]);
    if (!mat) return res.status(404).json({ error: 'Material not found' });
    if (mat.category !== 'board')
      return res.status(400).json({ error: `${mat.name} is not a board — only board can be held for a job` });

    const out = await tx(async (qc, oc) => {
      // Lock both lines for the life of the transaction, then re-plan from
      // freshly read rows — a client preview may be minutes stale.
      await qc('SELECT id FROM order_lines WHERE id=ANY($1::int[]) FOR UPDATE',
        [[+from_order_line_id, +to_order_line_id]]);
      const inputs = await moveInputs(+material_id, qc);
      const plan = planMove({
        materialId: +material_id,
        fromLineId: +from_order_line_id,
        toLineId: +to_order_line_id,
        qty: +qty,
        ...inputs,
      });
      if (!plan.ok)
        throw Object.assign(new Error(plan.blockers[0]), { status: 409, code: 'move_blocked', blockers: plan.blockers });

      const from = inputs.lines.find(l => l.id === +from_order_line_id);
      const to = inputs.lines.find(l => l.id === +to_order_line_id);
      const raised = [];

      for (const e of plan.effects) {
        if (e.kind === 'hold') {
          await qc(`INSERT INTO board_allocations
                      (material_id, order_line_id, qty, source, reason, created_by)
                    VALUES ($1,$2,$3,'stock',$4,$5)`,
            [+material_id, e.order_line_id, e.qty, reason, req.user.name]);
        }
        if (e.kind === 'pr_down') {
          const [pr] = await qc(
            `UPDATE requisitions SET qty=$1${e.close ? `, status='closed', status_reason=$3` : ''}
             WHERE id=$2 RETURNING *`,
            e.close ? [e.new_qty, e.requisition_id, `Covered from stock — ${reason}`]
                    : [e.new_qty, e.requisition_id]);
          await qc(`UPDATE requisition_lines SET qty=$1 WHERE requisition_id=$2`, [e.new_qty, e.requisition_id]);
          await syncMovedPrAllocation(qc, pr, e.close);
          await audit('requisition', e.requisition_id, e.close ? 'covered_from_stock' : 'reduced_by_move',
            `${e.text} — board moved from ${from.product_name} (${reason})`, qc, req.user.name);
        }
        if (e.kind === 'pr_new') {
          const pr_number = await nextNumber('CI-PR-', 'requisitions', 'pr_number', oc);
          const [pr] = await qc(
            `INSERT INTO requisitions (pr_number, material_id, qty, needed_by, reason,
                                       requested_by, priority, order_line_id)
             VALUES ($1,$2,$3,$4,$5,$6,'normal',$7) RETURNING *`,
            [pr_number, +material_id, e.qty, from.delivery_date || null,
             `Board moved to ${to.product_name} — auto-raised (${reason})`,
             req.user.name, e.order_line_id]);
          await qc(`INSERT INTO requisition_lines (requisition_id, material_id, qty, needed_by)
                    VALUES ($1,$2,$3,$4)`, [pr.id, +material_id, e.qty, from.delivery_date || null]);
          await syncMovedPrAllocation(qc, pr, false);
          raised.push(pr);
          await audit('requisition', pr.id, 'create_from_move',
            `${pr_number} auto-raised for ${from.product_name} — board moved to ${to.product_name} (${reason})`,
            qc, req.user.name);
        }
      }

      const summary = `${plan.qty} parent sheets moved ${from.product_name} → ${to.product_name} — ${reason}`;
      await audit('materials', +material_id, 'board_moved', summary, qc, req.user.name);
      await audit('order_line', from.id, 'board_moved_out', summary, qc, req.user.name);
      await audit('order_line', to.id, 'board_moved_in', summary, qc, req.user.name);

      return { ...plan, raised };
    });
    res.json(out);
  } catch (e) { next(e); }
});

// Same mirror rule as procurement.js, applied to PRs this route touches.
async function syncMovedPrAllocation(qc, pr, close) {
  if (!pr?.order_line_id) return;
  await qc(`UPDATE board_allocations SET status='released', released_at=now()
            WHERE requisition_id=$1 AND status='active'`, [pr.id]);
  if (close || !(Number(pr.qty) > 0)) return;
  await qc(`INSERT INTO board_allocations
              (material_id, order_line_id, qty, source, requisition_id, reason, created_by)
            VALUES ($1,$2,$3,'requisition',$4,$5,$6)`,
    [pr.material_id, pr.order_line_id, pr.qty, pr.id, `Incoming on ${pr.pr_number}`, pr.requested_by || null]);
}

r.post('/board/allocations/:id/release', canMove, async (req, res, next) => {
  try {
    const reason = String(req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'A reason is required to release held board' });
    const a = await one('SELECT * FROM board_allocations WHERE id=$1', [req.params.id]);
    if (!a) return res.status(404).json({ error: 'Not found' });
    if (a.status !== 'active') return res.status(409).json({ error: `This hold is already ${a.status}` });
    await q(`UPDATE board_allocations SET status='released', released_at=now(), released_by=$1, release_reason=$2
             WHERE id=$3`, [req.user.name, reason, a.id]);
    await audit('materials', a.material_id, 'board_hold_released',
      `${a.qty} sheets released from order line #${a.order_line_id} — ${reason}`, q, req.user.name);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
```

- [ ] **Step 2: Verify the move end to end**

Restart the server. Pick a board with at least two planned jobs and some stock. Preview first:

```bash
curl -sS -X POST localhost:4000/api/board/move/preview -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"material_id":7,"from_order_line_id":2,"to_order_line_id":1,"qty":5000}' | python3 -m json.tool
```

Expected: `"ok": true`, three effects, `"net_purchase_delta": 0`.

Then commit it, re-run the panel call, and confirm: `held` rose by 5,000, `free` fell by 5,000, the receiving job's PR shrank, and a new PR exists for the losing job.

- [ ] **Step 3: Confirm the losing job is not left short**

```bash
curl -sS localhost:4000/api/board/7/position/2 -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```

Expected: `short` is 0 — the auto-raised PR's mirrored allocation covers it. If `short` is 5,000, the mirror from Task 6 is not firing; fix that before continuing.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/board.js
git commit -m "feat(board): move board between jobs with preview, PR shrink and auto-raise"
```

---

## Task 11: The move dialog

**Files:**
- Modify: `client/src/components/BoardCommitments.jsx`

- [ ] **Step 1: Add the move button and dialog**

In `client/src/components/BoardCommitments.jsx`, add state:

```jsx
  const [move, setMove] = useState(null);      // { line, qty, reason }
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
```

Add a `Move to this PR` button in the job row, after the quantity block, shown only when there is a target and the row is not the target itself:

```jsx
                {target && l.id !== target.id && (
                  <Button size="sm" variant="secondary"
                    disabled={!!l.gang_run_id}
                    title={l.gang_run_id ? `Prints in gang ${l.gang_number} — move the gang's board from Planning` : ''}
                    onClick={() => setMove({ line: l, qty: String(Math.min(l.movable, target.holdable)), reason: '' })}>
                    Move to this PR
                  </Button>
                )}
```

Re-preview whenever the quantity changes:

```jsx
  useEffect(() => {
    if (!move || !target) { setPreview(null); return; }
    const qty = +String(move.qty).replace(/,/g, '');
    if (!(qty > 0)) { setPreview(null); return; }
    let cancelled = false;
    api.post('/board/move/preview', {
      material_id: materialId,
      from_order_line_id: move.line.id,
      to_order_line_id: target.id,
      qty,
    }).then(p => { if (!cancelled) setPreview(p); }).catch(() => {});
    return () => { cancelled = true; };
  }, [move?.line?.id, move?.qty, target?.id, materialId]);
```

Add the dialog below the main modal:

```jsx
      <Modal open={!!move} onClose={() => { setMove(null); setPreview(null); }}
        title={target ? `Move board to ${target.product_name}` : 'Move board'}
        footer={
          <>
            <Button variant="secondary" onClick={() => { setMove(null); setPreview(null); }}>Cancel</Button>
            <Button disabled={busy || !preview?.ok || !move?.reason.trim()} onClick={doMove}>
              {busy ? 'Moving…' : 'Move the board'}
            </Button>
          </>
        }>
        {move && (
          <div className="space-y-3.5">
            <p className="text-sm text-slate-500">Taking it away from <b className="text-slate-700">{move.line.product_name}</b></p>

            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-500">Sheets to move</label>
              <input className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm tabular-nums"
                value={move.qty} onChange={e => setMove({ ...move, qty: e.target.value })} />
              <p className="mt-1 text-[11px] text-slate-400">
                All {fmt.num(move.line.movable)} of {move.line.product_name}'s board. Type less to split it.
              </p>
            </div>

            {preview && (
              <div className={`rounded-xl px-3.5 py-3 ${preview.ok ? 'bg-slate-50' : 'bg-red-50'}`}>
                <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  {preview.ok ? 'What will happen' : 'This move is not possible'}
                </div>
                {preview.ok ? (
                  <>
                    <ul className="space-y-1 text-sm text-slate-700">
                      {preview.effects.map((e, i) => <li key={i}>{e.text}</li>)}
                    </ul>
                    <p className="mt-2 border-t border-slate-200 pt-2 text-xs text-slate-500">
                      Nothing extra is bought. Board on order stays the same.
                    </p>
                  </>
                ) : (
                  <ul className="space-y-1 text-sm font-semibold text-red-700">
                    {preview.blockers.map((b, i) => <li key={i}>{b}</li>)}
                  </ul>
                )}
              </div>
            )}

            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-500">Why are you moving it?</label>
              <input className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm"
                placeholder="Dispatch pulled forward"
                value={move.reason} onChange={e => setMove({ ...move, reason: e.target.value })} />
            </div>
          </div>
        )}
      </Modal>
```

And the commit handler:

```jsx
  const doMove = async () => {
    setBusy(true);
    try {
      const out = await api.post('/board/move', {
        material_id: materialId,
        from_order_line_id: move.line.id,
        to_order_line_id: target.id,
        qty: +String(move.qty).replace(/,/g, ''),
        reason: move.reason.trim(),
      });
      const newPr = out.raised?.[0];
      toast.success(newPr
        ? `Board moved — ${newPr.pr_number} raised for ${move.line.product_name}`
        : 'Board moved');
      setMove(null); setPreview(null);
      await load();
      onChanged?.();
    } catch (e) {
      toast.error(e.data?.blockers?.[0] || e.message);
    } finally { setBusy(false); }
  };
```

- [ ] **Step 2: Verify in the running app**

Open Procurement → Requisitions at desktop width, click a board chip, click `Move to this PR` on another job. Check:

- the quantity pre-fills with the whole job
- the "what will happen" list names both jobs and both PRs
- `Move the board` stays disabled until a reason is typed
- after moving, the panel reloads with `held` up and `free` down
- the Requisitions list shows the shrunk PR and the new auto-raised one

- [ ] **Step 3: Commit**

```bash
git add client/src/components/BoardCommitments.jsx
git commit -m "feat(board): move dialog with server-computed consequences"
```

---

## Task 12: Re-point a PR to a different job

**Files:**
- Modify: `server/src/routes/procurement.js`
- Modify: `client/src/components/BoardCommitments.jsx`

- [ ] **Step 1: Add the endpoint**

In `server/src/routes/procurement.js`:

```js
// Send an unconverted PR's incoming material to a different job. Once the PR is
// on a PO the GRN owns the material and re-pointing is a different problem.
r.post('/requisitions/:id/reassign', canBuy, async (req, res, next) => {
  try {
    const reason = String(req.body.reason || '').trim();
    const orderLineId = +req.body.order_line_id;
    if (!reason) return res.status(400).json({ error: 'A reason is required to re-point a requisition' });
    if (!orderLineId) return res.status(400).json({ error: 'Pick the job this requisition is for' });

    const out = await tx(async (qc, oc) => {
      const pr = await oc('SELECT * FROM requisitions WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!pr) throw Object.assign(new Error('Not found'), { status: 404 });
      if (!['pending', 'approved'].includes(pr.status))
        throw Object.assign(new Error(`A ${pr.status} requisition can no longer be re-pointed`), { status: 409 });

      const line = await oc(`
        SELECT ol.id, p.name AS product_name FROM order_lines ol
        JOIN products p ON p.id=ol.product_id WHERE ol.id=$1`, [orderLineId]);
      if (!line) throw Object.assign(new Error('That job is no longer planned'), { status: 409 });

      const before = pr.order_line_id;
      const [row] = await qc('UPDATE requisitions SET order_line_id=$1 WHERE id=$2 RETURNING *', [orderLineId, pr.id]);
      await syncPrAllocation(qc, row);
      await audit('requisition', pr.id, 'reassign',
        `${pr.pr_number} re-pointed${before ? ` from order line #${before}` : ''} to ${line.product_name} — ${reason}`,
        qc, req.user.name);
      await audit('order_line', orderLineId, 'pr_reassigned_in',
        `${pr.pr_number} (${pr.qty} sheets) now buys for this job — ${reason}`, qc, req.user.name);
      if (before)
        await audit('order_line', before, 'pr_reassigned_out',
          `${pr.pr_number} no longer buys for this job — ${reason}`, qc, req.user.name);
      return row;
    });
    res.json(out);
  } catch (e) { next(e); }
});
```

- [ ] **Step 2: Add the change link to the panel**

In `BoardCommitments.jsx`, inside the `prContext` block, add a change control under the job name. When `target` is null (an old PR with no link) the same control reads `Which job is this PR for?` — this is what unblocks pre-existing requisitions like CI-PR-0006.

```jsx
              <button type="button" onClick={() => setRepoint({ line_id: target?.id || '', reason: '' })}
                className="mt-1.5 text-[11px] font-semibold text-brand-600 underline">
                {target ? 'Change which job this PR is for' : 'Which job is this PR for?'}
              </button>
```

Add the state, the handler and the modal:

```jsx
  const [repoint, setRepoint] = useState(null);   // { line_id, reason }

  const doRepoint = async () => {
    setBusy(true);
    try {
      await api.post(`/requisitions/${prContext.id}/reassign`, {
        order_line_id: +repoint.line_id,
        reason: repoint.reason.trim(),
      });
      const picked = data.lines.find(l => l.id === +repoint.line_id);
      toast.success(`${prContext.pr_number} now buys for ${picked?.product_name || 'that job'}`);
      setRepoint(null);
      await load();
      onChanged?.();
    } catch (e) {
      toast.error(e.message);
    } finally { setBusy(false); }
  };
```

```jsx
      <Modal open={!!repoint} onClose={() => setRepoint(null)}
        title={`Which job is ${prContext?.pr_number || 'this PR'} buying for?`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setRepoint(null)}>Cancel</Button>
            <Button disabled={busy || !repoint?.line_id || !repoint?.reason.trim()} onClick={doRepoint}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </>
        }>
        {repoint && (
          <div className="space-y-3.5">
            <Field label="Job">
              <Select value={repoint.line_id} onChange={e => setRepoint({ ...repoint, line_id: e.target.value })}>
                <option value="">Pick a job…</option>
                {data.lines.map(l => (
                  <option key={l.id} value={l.id}>
                    {l.product_name} — PO {l.po_number} ({fmt.num(l.need)} sheets)
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Why?">
              <Input placeholder="Raised before jobs were linked to PRs"
                value={repoint.reason} onChange={e => setRepoint({ ...repoint, reason: e.target.value })} />
            </Field>
            <p className="rounded-xl bg-slate-50 px-3 py-2.5 text-xs text-slate-500">
              The incoming {fmt.num(prContext?.qty)} sheets will count as coverage for the job you pick,
              and stop counting for the one it was on.
            </p>
          </div>
        )}
      </Modal>
```

The list only offers jobs planned on this board, so a PR cannot be pointed at a job that does not use the material it buys.

- [ ] **Step 3: Verify in the running app**

Open a PR raised before Task 1 (no `order_line_id`). The panel must show the amber "does not name a job yet" note and the `Which job is this PR for?` link. Pick a job, give a reason, save. The blue block must then show that job's name and figures.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/procurement.js client/src/components/BoardCommitments.jsx
git commit -m "feat(procurement): re-point a requisition to a different job"
```

---

## Task 13: The Planning Engine side

**Files:**
- Modify: `client/src/pages/Planning.jsx` (board position block around `:1232`, short banner around `:1257`)

- [ ] **Step 1: Show Free alongside Available and Committed**

In the board position block, add a fourth stat after `Committed`:

```jsx
                        <Stat small label="Free" value={fmt.num(ctx.stock.free ?? position.available)}
                          accent={(ctx.stock.free ?? 0) > 0 ? 'text-emerald-600' : 'text-red-600'} />
```

When the line has board held for it, add a line under the stats:

```jsx
                      {ctx.stock.held_for_me > 0 && (
                        <p className="mt-1.5 rounded-lg bg-emerald-50 px-2.5 py-1.5 text-[11px] font-semibold text-emerald-700">
                          {fmt.num(ctx.stock.held_for_me)} sheets are held for this job
                        </p>
                      )}
```

- [ ] **Step 2: Add the second button on the short banner**

Beside the existing `Raise PR for N`:

```jsx
                          <Button size="sm" variant="secondary" onClick={() => setBoardPanel(true)}>
                            Take board from another job
                          </Button>
```

Add `const [boardPanel, setBoardPanel] = useState(false);` and render the shared panel, passing a synthetic PR context so the receiving job is this line:

```jsx
      <BoardCommitments
        open={boardPanel}
        onClose={() => setBoardPanel(false)}
        materialId={boardSel?.id}
        prContext={{ pr_number: 'this job', order_line_id: planLine?.id, id: null }}
        onChanged={async () => setCtx(await loadCtx(planLine, boardSel.id))} />
```

Because `prContext.id` is null, the panel must hide the re-point link when there is no requisition. Guard it:

```jsx
              {prContext?.id && (
                <button type="button" ... >Change which job this PR is for</button>
              )}
```

- [ ] **Step 3: Verify in the running app**

Open Planning on a short line. The position box shows Free. `Take board from another job` opens the panel with this job highlighted as the receiver. Move board from another job and confirm `short` falls without leaving the page.

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/Planning.jsx client/src/components/BoardCommitments.jsx
git commit -m "feat(planning): free/held split and take-board-from-another-job"
```

---

## Task 14: The floor warning

Board is issued at first-stage start — `consumeFifo(...)` at `server/src/routes/production.js:511`. Warn, never block.

**Files:**
- Modify: `server/src/routes/production.js`
- Modify: `client/src/pages/Section.jsx`

- [ ] **Step 1: Check holds before issuing**

In `server/src/routes/production.js`, inside `POST /job-stages/:id/start`, immediately before the `consumeFifo` call at `:511`:

```js
        // Board held for OTHER jobs is a warning, never a block — the floor is
        // never hard-stopped in this ERP (see adjustBoardStock, which lets stock
        // go negative rather than halt cutting). The operator may proceed; the
        // acknowledgement is audited.
        const holds = await oc(`
          SELECT COALESCE(SUM(a.qty),0) AS held FROM board_allocations a
          WHERE a.material_id=$1 AND a.status='active' AND a.source='stock'
            AND a.order_line_id IS DISTINCT FROM $2`, [eff.board_material_id, jc.order_line_id]);
        const heldOther = Number(holds?.held || 0);
        if (heldOther > 0 && !req.body.confirm_allocation) {
          const avail = await oc(`SELECT COALESCE(SUM(qty),0) AS q FROM stock_batches
                                  WHERE material_id=$1 AND status='available'`, [eff.board_material_id]);
          if (jc.sheets_issued > Number(avail.q) - heldOther) {
            const who = await oc(`
              SELECT p.name FROM board_allocations a
              JOIN order_lines ol ON ol.id=a.order_line_id
              JOIN products p ON p.id=ol.product_id
              WHERE a.material_id=$1 AND a.status='active' AND a.source='stock'
                AND a.order_line_id IS DISTINCT FROM $2 ORDER BY a.qty DESC LIMIT 1`,
              [eff.board_material_id, jc.order_line_id]);
            throw Object.assign(new Error(
              `${Math.round(heldOther).toLocaleString('en-IN')} sheets of this board are held for ${who?.name || 'another job'}. Starting here will use them.`),
              { status: 409, code: 'board_allocation_warning' });
          }
        }
```

And immediately after `consumeFifo` succeeds:

```js
        // This job's own hold has now become real board on the floor — retire it
        // so it stops counting against free stock forever.
        await qc(`UPDATE board_allocations SET status='consumed'
                  WHERE material_id=$1 AND order_line_id=$2 AND status='active' AND source='stock'`,
          [eff.board_material_id, jc.order_line_id]);
        if (req.body.confirm_allocation)
          await audit('job_card', jc.id, 'allocation_override_ack',
            `Board held for another job used to start ${st.stage} on ${jc.jc_number}`, qc, req.user.name);
```

Without that first statement a hold survives its own job's consumption, `free` drifts permanently low, and every later job on that board reads short. It is the counterpart to the release-on-PR-close rule in Task 6.

- [ ] **Step 2: Handle the 409 on the client**

In `client/src/pages/Section.jsx`, find the start-stage call and the existing strength-mixup confirm (`confirm_collision`) — the new confirm follows the same shape.

Add state beside the other confirm state:

```jsx
  const [allocWarn, setAllocWarn] = useState(null);   // { message, body }
```

Wrap the start call so the structured 409 opens a confirm instead of a toast. `api.js` already suppresses the central toast for errors carrying a `code`, so nothing else is needed:

```jsx
  const startStage = async (body, opts = {}) => {
    const payload = { ...body, ...(opts.confirmAllocation ? { confirm_allocation: true } : {}) };
    try {
      await api.post(`/job-stages/${stage.id}/start`, payload);
      setAllocWarn(null);
      load();
    } catch (e) {
      if (e.data?.code === 'board_allocation_warning') {
        setAllocWarn({ message: e.data.error, body });
        return;
      }
      throw e;
    }
  };
```

And render the confirm beside the other dialogs:

```jsx
      <ConfirmDialog
        open={!!allocWarn}
        onClose={() => setAllocWarn(null)}
        onConfirm={() => startStage(allocWarn.body, { confirmAllocation: true })}
        title="This board is held for another job"
        message={`${allocWarn?.message || ''} Starting anyway is allowed — it will be recorded against this job card.`}
        confirmLabel="Start anyway" />
```

Point every existing start-button handler at `startStage(...)` rather than calling `api.post` directly, so the guard cannot be bypassed by one forgotten call site.

- [ ] **Step 3: Verify in the running app**

Hold board for job A via the panel until free stock is below job B's requirement. Start job B's first stage — the amber confirm must appear naming job A. Confirm it; the stage starts and the ack is recorded:

```bash
psql "postgresql://postgres:postgres@localhost:5439/cierp" -c \
  "SELECT entity, entity_id, action, detail FROM audit_log WHERE action='allocation_override_ack' ORDER BY id DESC LIMIT 1;"
```

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/production.js client/src/pages/Section.jsx
git commit -m "feat(floor): warn when starting into board held for another job"
```

---

## Task 15: Full verification

**Files:** none — this task only runs checks.

- [ ] **Step 1: Run the full verification**

```bash
npm run verify
```

Expected: baseline freshness passes, all server tests pass, client build succeeds. If baseline freshness fails, re-run `npm run db:baseline` and commit the result.

- [ ] **Step 2: Confirm the equivalence property still holds**

```bash
npm test -w server 2>&1 | grep -A2 "PROPERTY"
```

Expected: pass. This is the guarantee that boards with no allocations behave exactly as they did before the wave.

- [ ] **Step 3: Check production schema drift before any deploy**

```bash
DATABASE_URL="<supabase colour-impressions-prod url>" npm run db:check
```

Expected: the only difference is the missing `board_allocations` table, which `supabase/migrations/0005_board_allocations.sql` adds. Production holds real orders that local does not — never copy local over production.

- [ ] **Step 4: Walk the whole story once in the running app**

1. Planning → a short line → `Take board from another job` → move → `short` falls
2. Procurement → Requisitions → the losing job's auto-raised PR exists at the moved quantity
3. Procurement → the receiving job's PR shrank by the same quantity
4. Open any board's Masters 360 drawer → held/free agree with the panel
5. Floor → start a stage into held board → amber confirm appears

- [ ] **Step 5: Commit anything outstanding**

```bash
git status --short --branch
```

Expected: clean. Deployment is a separate, explicitly requested step — do not run `npm run deploy:prod` here.

---

## Notes for the engineer

**Do not "fix" the property test by changing it.** If `PROPERTY: with no allocations, the new engine equals the old formula` fails, the new math is wrong. That test is the whole safety argument for putting this in front of a live plant.

**Quantities are parent sheets everywhere.** `sheets_required` is the child print-sheet count and is larger by `children_per_parent`. Using it raw over-states demand. `lineNeed()` handles the fallback; call it rather than reading the columns directly.

**`EFF_BOARD_ID` is not optional.** Any query resolving a line to a board must use it, or a board picked in the planning engine via `spec_override` reads as free when it is not.

**The server may not hot-reload.** After server edits, restart `:4000` and re-check. A dead server renders as empty screens, not errors.
