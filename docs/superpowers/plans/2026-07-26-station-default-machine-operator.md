# Station Default Machine + Operator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** At the Cutting and Printing stations, the Start modal opens with the machine and operator already filled in — printing from the press Print Planning assigned, cutting from a flagged default machine — so the operator only ticks line clearance and starts.

**Architecture:** A pure resolver module (`client/src/lib/runAssignment.js`) decides machine + operator from the queue row and the station's machine list; `Section.jsx` calls it when the modal opens and renders a filled assignment card with a **Change** escape hatch. A new `machines.is_default` flag, editable in Masters → Machines, supplies the cutting default. The server gains one audit line when a printing run starts on a press other than the planned one.

**Tech Stack:** Node 20 + Express + embedded PostgreSQL (server), React 18 + Vite + Tailwind (client), `node --test` for tests.

**Spec:** `docs/superpowers/specs/2026-07-26-station-default-machine-operator-design.md`

**Repo:** `/Users/anikdua/Documents/CI ERP FInal/ci-erp` — all paths below are relative to it.

---

## Context an engineer new to this codebase needs

- **Tests are pure-function tests.** `npm test -w server` runs `node --test src/*.test.js`. No test touches a database. Route logic that needs testing is extracted into a pure helper in `server/src/helpers.js` (see `finaliseBlock`, `printReverseBlockers`) and the route calls it.
- **The client has no test runner.** Pure client logic that deserves tests lives in `client/src/lib/` and is imported *by a server test file* — the established precedent is `server/src/board-math.test.js:133` importing `../../client/src/lib/boardMath.js`.
- **Schema lives in `server/src/db.js` → `init()`**, applied on startup in local dev only. Every statement must be idempotent and ordered after the table it touches. After editing it you MUST regenerate the baseline (`npm run db:baseline`) or `npm run verify` fails.
- **The queue row shape** (from `STAGE_VIEW` in `server/src/routes/floor.js:75`) carries `machine_id` (the stage's own machine, normally null before start), `press_machine_id` (the job card's planned press, `jc.machine_id`), and `operator` (`COALESCE(js.operator, first crew member of COALESCE(js.machine_id, jc.machine_id))`).
- **Careful — `row.operator` lies at non-printing stations.** Its fallback join keys off `COALESCE(js.machine_id, jc.machine_id)`, and `jc.machine_id` is the *press*. So a pending **cutting** row reports the press operator (e.g. "Shiv Kumar"). The resolver must only accept `row.operator` when that name is actually in the resolved machine's crew. There is a test for exactly this.
- **Live plant data** this is designed against: cutting has Board Cutting Machine (id 11) and Automatic Label Cutting Machine (id 12), both crewed only by Ankit; printing has presses 8/9/13 crewed by Modi/Dileep/Shiv Kumar respectively — exactly one each.

## File structure

| File | Responsibility |
|---|---|
| `client/src/lib/runAssignment.js` | **New.** Pure resolution: which machine, which operator, is it auto. No React, no I/O. |
| `server/src/run-assignment.test.js` | **New.** `node --test` coverage of the above. |
| `server/src/helpers.js` | Add `pressOverride` — pure predicate for "started on a different press than planned". |
| `server/src/press-override.test.js` | **New.** Covers `pressOverride`. |
| `server/src/db.js` | `machines.is_default` column + guarded seed. |
| `supabase/migrations/0001_baseline_schema.sql` | Regenerated, not hand-edited. |
| `server/src/routes/masters.js` | Accept `is_default`; enforce one default per machine category. |
| `client/src/pages/Masters.jsx` | The `Default for this station` field + list column. |
| `client/src/pages/Section.jsx` | Call the resolver on open; render the assignment card; blank machine option. |
| `server/src/routes/production.js` | Wire the `press_override` audit. |

---

### Task 1: Pure run-assignment resolver

**Files:**
- Create: `client/src/lib/runAssignment.js`
- Create: `server/src/run-assignment.test.js`

- [ ] **Step 1: Write the failing tests**

Create `server/src/run-assignment.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
// Client-only module — tested from here because the server test runner is the
// only one in the repo. Same precedent as board-math.test.js.
import {
  autoAssigns, resolveMachine, resolveOperator, resolveAssignment,
} from '../../client/src/lib/runAssignment.js';

// The real plant machines this is designed against.
const BOARD  = { id: 11, name: 'Board Cutting Machine', is_default: 1, operators: [{ id: 1, name: 'Ankit' }] };
const LABEL  = { id: 12, name: 'Automatic Label Cutting Machine', is_default: 0, operators: [{ id: 1, name: 'Ankit' }] };
const PRESS1 = { id: 8,  name: 'Offset Printing Press No. 1', is_default: 0, operators: [{ id: 2, name: 'Modi' }] };
const PRESS3 = { id: 13, name: 'Offset Printing Press No. 3', is_default: 0, operators: [{ id: 4, name: 'Shiv Kumar' }] };
const CUTTING = [LABEL, BOARD];      // deliberately alphabetical — LABEL sorts first
const PRESSES = [PRESS1, PRESS3];

// ── autoAssigns ───────────────────────────────────────────────────────
test('autoAssigns: only cutting and printing prefill', () => {
  assert.equal(autoAssigns('cutting'), true);
  assert.equal(autoAssigns('printing'), true);
  assert.equal(autoAssigns('die_cutting'), false);
  assert.equal(autoAssigns('coating'), false);
  assert.equal(autoAssigns('qc'), false);
  assert.equal(autoAssigns(undefined), false);
});

// ── resolveMachine ────────────────────────────────────────────────────
test('resolveMachine: printing takes the press Print Planning assigned', () => {
  const row = { machine_id: null, press_machine_id: 13 };
  assert.equal(resolveMachine('printing', row, PRESSES).id, 13);
});
test('resolveMachine: the planned press beats list order', () => {
  // Press No. 1 sorts first — the old code posted it regardless. Regression guard.
  const row = { machine_id: null, press_machine_id: 13 };
  assert.notEqual(resolveMachine('printing', row, PRESSES).id, 8);
});
test('resolveMachine: a machine already on the stage wins over the plan', () => {
  const row = { machine_id: 8, press_machine_id: 13 };
  assert.equal(resolveMachine('printing', row, PRESSES).id, 8);
});
test('resolveMachine: a planned press outside this station list falls through', () => {
  // Press-scoped operator, or a deactivated press: id 99 is not in the list.
  const row = { machine_id: null, press_machine_id: 99 };
  assert.equal(resolveMachine('printing', row, PRESSES), null);
});
test('resolveMachine: cutting takes the flagged default, not the first in the list', () => {
  const row = { machine_id: null, press_machine_id: 13 };
  assert.equal(resolveMachine('cutting', row, CUTTING).id, 11);
});
test('resolveMachine: cutting ignores the job press entirely', () => {
  // jc.machine_id is the PRESS — it must never resolve a cutting machine.
  const row = { machine_id: null, press_machine_id: 8 };
  assert.equal(resolveMachine('cutting', row, [LABEL]).id, 12);
});
test('resolveMachine: a lone machine wins when nothing is flagged', () => {
  assert.equal(resolveMachine('cutting', { machine_id: null }, [LABEL]).id, 12);
});
test('resolveMachine: several machines, none flagged → nothing resolved', () => {
  const plain = [{ ...LABEL }, { ...BOARD, is_default: 0 }];
  assert.equal(resolveMachine('cutting', { machine_id: null }, plain), null);
});
test('resolveMachine: non-auto sections never resolve', () => {
  assert.equal(resolveMachine('die_cutting', { machine_id: null }, CUTTING), null);
});
test('resolveMachine: empty or missing machine list is safe', () => {
  assert.equal(resolveMachine('cutting', { machine_id: null }, []), null);
  assert.equal(resolveMachine('cutting', { machine_id: null }, undefined), null);
});

// ── resolveOperator ───────────────────────────────────────────────────
test('resolveOperator: a machine with one crew member needs no choice', () => {
  assert.equal(resolveOperator(PRESS3, { operator: null }), 'Shiv Kumar');
  assert.equal(resolveOperator(BOARD, { operator: null }), 'Ankit');
});
test('resolveOperator: rejects an operator who is not on this machine', () => {
  // A pending CUTTING row reports the press operator via STAGE_VIEW's fallback
  // join. Shiv Kumar must never be filled in as the board cutter.
  const twoCrew = { id: 11, name: 'Board Cutting Machine', operators: [{ id: 1, name: 'Ankit' }, { id: 9, name: 'Vikas' }] };
  assert.equal(resolveOperator(twoCrew, { operator: 'Shiv Kumar' }), '');
});
test('resolveOperator: honours a planned operator who IS on this machine', () => {
  const twoCrew = { id: 11, name: 'Board Cutting Machine', operators: [{ id: 1, name: 'Ankit' }, { id: 9, name: 'Vikas' }] };
  assert.equal(resolveOperator(twoCrew, { operator: 'Vikas' }), 'Vikas');
});
test('resolveOperator: several crew and no plan → blank, the picker decides', () => {
  const twoCrew = { id: 11, name: 'Board Cutting Machine', operators: [{ id: 1, name: 'Ankit' }, { id: 9, name: 'Vikas' }] };
  assert.equal(resolveOperator(twoCrew, { operator: null }), '');
});
test('resolveOperator: an uncrewed machine leaves the operator blank', () => {
  assert.equal(resolveOperator({ id: 38, name: 'Manual Pasting', operators: [] }, { operator: 'Ankit' }), '');
  assert.equal(resolveOperator(null, { operator: 'Ankit' }), '');
});

// ── resolveAssignment ─────────────────────────────────────────────────
test('resolveAssignment: printing resolves press + its operator, flagged auto', () => {
  const a = resolveAssignment('printing', { machine_id: null, press_machine_id: 13, operator: 'Shiv Kumar' }, PRESSES);
  assert.deepEqual(
    { machineId: a.machineId, operator: a.operator, auto: a.auto },
    { machineId: '13', operator: 'Shiv Kumar', auto: true });
});
test('resolveAssignment: cutting resolves the default machine + its operator', () => {
  const a = resolveAssignment('cutting', { machine_id: null, press_machine_id: 13, operator: 'Shiv Kumar' }, CUTTING);
  assert.deepEqual(
    { machineId: a.machineId, operator: a.operator, auto: a.auto },
    { machineId: '11', operator: 'Ankit', auto: true });
});
test('resolveAssignment: machineId is a string — Select values are strings', () => {
  assert.equal(typeof resolveAssignment('printing', { press_machine_id: 13 }, PRESSES).machineId, 'string');
});
test('resolveAssignment: a manual section resolves to nothing at all', () => {
  assert.deepEqual(
    resolveAssignment('coating', { machine_id: null, press_machine_id: 13, operator: 'Shiv Kumar' }, PRESSES),
    { machine: null, machineId: '', operator: '', auto: false });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd "/Users/anikdua/Documents/CI ERP FInal/ci-erp" && node --test server/src/run-assignment.test.js
```

Expected: FAIL — `Cannot find module '.../client/src/lib/runAssignment.js'`.

- [ ] **Step 3: Write the module**

Create `client/src/lib/runAssignment.js`:

```js
// Which machine and which operator a job starts on.
//
// At Cutting and Printing the plant has already decided both: printing gets its
// press from the Print Planning board, and cutting runs on one flagged default
// machine crewed by one man. So the Start modal arrives filled and the operator
// only ticks line clearance. Every other station picks by hand — and picks from
// a blank, so no machine is ever recorded by silence.
//
// Pure functions, no React. Covered by server/src/run-assignment.test.js.

// The only stations that prefill. Widening this list is a plant decision, not a
// code cleanup: a station qualifies when its machines each have ONE dedicated
// operator, which is what makes the operator unambiguous.
export const AUTO_ASSIGN_SECTIONS = ['cutting', 'printing'];

export const autoAssigns = section => AUTO_ASSIGN_SECTIONS.includes(section);

// The machine this run should start on, or null when nothing can be resolved.
// Only a machine present in `machines` can win — that list is this station's
// active machines, already narrowed by the user's press scope — so a retired or
// out-of-scope machine falls through to the next rule instead of being posted.
export function resolveMachine(section, row, machines) {
  if (!autoAssigns(section)) return null;
  const list = machines || [];
  const pick = id => (id == null ? null : list.find(m => String(m.id) === String(id)) || null);
  return pick(row?.machine_id)                                              // already on the stage
    || (section === 'printing' ? pick(row?.press_machine_id) : null)        // the planned press
    || list.find(m => Number(m.is_default) === 1)                           // the station's default
    || (list.length === 1 ? list[0] : null)                                 // the only machine there is
    || null;
}

// The operator for a resolved machine. One active assigned person means there is
// nothing to choose. Anything else stays blank, and the server falls back to the
// planned operator or the signed-in user exactly as it does today.
//
// The `crew.some` guard matters: a pending row's `operator` comes from a
// COALESCE that falls back to the JOB CARD's press, so a cutting row reports the
// PRESS operator. Only a name actually on this machine is accepted.
export function resolveOperator(machine, row) {
  const crew = machine?.operators || [];
  if (crew.length === 1) return crew[0].name;
  const planned = row?.operator;
  return planned && crew.some(o => o.name === planned) ? planned : '';
}

// What the Start modal opens with. `auto` is true only when a machine was
// actually resolved — that is what earns the AUTO chip and hides the pickers.
export function resolveAssignment(section, row, machines) {
  const machine = resolveMachine(section, row, machines);
  return {
    machine,
    machineId: machine ? String(machine.id) : '',
    operator: machine ? resolveOperator(machine, row) : '',
    auto: !!machine,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd "/Users/anikdua/Documents/CI ERP FInal/ci-erp" && node --test server/src/run-assignment.test.js
```

Expected: PASS — all tests, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/runAssignment.js server/src/run-assignment.test.js && git commit -m "feat(floor): pure resolver for a station's default machine + operator"
```

---

### Task 2: `pressOverride` helper

**Files:**
- Modify: `server/src/helpers.js` (append)
- Create: `server/src/press-override.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/src/press-override.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pressOverride } from './helpers.js';

test('pressOverride: starting on a press other than the planned one', () => {
  assert.equal(pressOverride('printing', 13, 8), true);
});
test('pressOverride: starting on the planned press is not an override', () => {
  assert.equal(pressOverride('printing', 13, 13), false);
});
test('pressOverride: ids compare numerically, not as strings', () => {
  assert.equal(pressOverride('printing', 13, '13'), false);
  assert.equal(pressOverride('printing', '13', 8), true);
});
test('pressOverride: nothing planned means nothing was overridden', () => {
  assert.equal(pressOverride('printing', null, 8), false);
});
test('pressOverride: no machine started means nothing was overridden', () => {
  assert.equal(pressOverride('printing', 13, null), false);
});
test('pressOverride: only printing has a planned press', () => {
  assert.equal(pressOverride('cutting', 13, 8), false);
  assert.equal(pressOverride('die_cutting', 13, 8), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd "/Users/anikdua/Documents/CI ERP FInal/ci-erp" && node --test server/src/press-override.test.js
```

Expected: FAIL — `pressOverride is not a function`.

- [ ] **Step 3: Append the helper to `server/src/helpers.js`**

```js
// A printing run started on a press other than the one Print Planning assigned.
// Legitimate — a press breaks down, the load gets rebalanced — but never silent:
// the planning board still shows the old press, so the switch is audited.
// Only printing has a planned press (job_cards.machine_id).
export const pressOverride = (stage, plannedId, startedId) =>
  stage === 'printing' && plannedId != null && startedId != null
  && Number(plannedId) !== Number(startedId);
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd "/Users/anikdua/Documents/CI ERP FInal/ci-erp" && node --test server/src/press-override.test.js
```

Expected: PASS — `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add server/src/helpers.js server/src/press-override.test.js && git commit -m "feat(production): pressOverride predicate for a press switched at start"
```

---

### Task 3: `machines.is_default` column and seed

**Files:**
- Modify: `server/src/db.js` (append a block before the closing `}` of `init()`, currently at line 1545)
- Modify: `supabase/migrations/0001_baseline_schema.sql` (regenerated, never hand-edited)

- [ ] **Step 1: Add the migration block**

In `server/src/db.js`, the final statement of `init()` is a `pool.query` template ending with:

```js
CREATE INDEX IF NOT EXISTS idx_orders_open_delivery ON orders (delivery_date) WHERE status = 'open';
`);
}
```

Insert a new block between the `` `); `` and the closing `}`:

```js
  // Station default machine. The Start modal at Cutting and Printing fills the
  // machine in rather than asking; printing takes its press from Print Planning,
  // cutting takes whichever machine carries this flag. One flag per category,
  // enforced on write in routes/masters.js.
  await pool.query(`
ALTER TABLE machines ADD COLUMN IF NOT EXISTS is_default INTEGER NOT NULL DEFAULT 0;

-- Board cutting is the normal path for cartons, so it is the plant's cutting
-- default. Guarded on "no default yet in this category" so it seeds once and
-- never overrides a later choice made in Masters → Machines.
UPDATE machines SET is_default = 1
WHERE type = 'cutting' AND name = 'Board Cutting Machine'
  AND NOT EXISTS (SELECT 1 FROM machines WHERE type = 'cutting' AND is_default = 1);
`);
```

- [ ] **Step 2: Restart the local server so `init()` applies it, then verify the column and the seed**

The dev server on :4000 runs `node --watch`, but a `db.js` edit may not reliably re-run `init()` — verify against the database directly rather than trusting a reload:

```bash
cd "/Users/anikdua/Documents/CI ERP FInal/ci-erp" && node -e "import('pg').then(async({default:pg})=>{const c=new pg.Client('postgresql://postgres:postgres@localhost:5439/cierp');await c.connect();const r=await c.query(\"SELECT id,name,type,is_default FROM machines WHERE type='cutting' ORDER BY name\");console.table(r.rows);await c.end();})"
```

Expected: Board Cutting Machine has `is_default: 1`, Automatic Label Cutting Machine has `0`. If the column does not exist, the server did not re-run `init()` — restart it:

```bash
cd "/Users/anikdua/Documents/CI ERP FInal/ci-erp" && npm run dev -w server
```

- [ ] **Step 3: Prove the block is idempotent and correctly ordered**

```bash
cd "/Users/anikdua/Documents/CI ERP FInal/ci-erp" && npm run db:baseline && npm run db:check -- --baseline
```

Expected: the baseline regenerates and replays into an empty database with no error.

- [ ] **Step 4: Confirm `npm run verify` no longer reports a stale baseline**

```bash
cd "/Users/anikdua/Documents/CI ERP FInal/ci-erp" && node scripts/build-baseline.mjs --check
```

Expected: exit 0, no "stale" message.

- [ ] **Step 5: Commit**

```bash
git add server/src/db.js supabase/migrations/0001_baseline_schema.sql && git commit -m "feat(masters): machines.is_default, seeded to the Board Cutting Machine"
```

---

### Task 4: Masters API accepts `is_default`, one per category

**Files:**
- Modify: `server/src/routes/masters.js:33` (the `MASTERS.machines` column list) and the generic `POST`/`PUT` handlers

- [ ] **Step 1: Add the column to the machines master**

At `server/src/routes/masters.js:33`, change:

```js
  machines: ['code', 'name', 'model', 'type', 'capacity_per_hour', 'status', 'active'],
```

to:

```js
  machines: ['code', 'name', 'model', 'type', 'capacity_per_hour', 'status', 'active', 'is_default'],
```

- [ ] **Step 2: Enforce one default per category after a write**

The `POST /${table}` and `PUT /${table}/:id` handlers are generic across all masters. Add a shared helper directly above the `for (const [table, cols] of Object.entries(MASTERS))` loop:

```js
// One default machine per category. The Start modal resolves a station's default
// by flag, so two flagged machines of the same type would make the pick
// arbitrary — clear the siblings whenever a machine claims the flag.
async function keepOneDefaultMachine(row) {
  if (!row || Number(row.is_default) !== 1) return;
  await q(`UPDATE machines SET is_default = 0 WHERE type = $1 AND id <> $2 AND is_default = 1`,
    [row.type, row.id]);
}
```

In the `POST` handler, after `await audit(table, row.id, 'create', null, q, req.user.name);`:

```js
      if (table === 'machines') await keepOneDefaultMachine(row);
```

In the `PUT` handler, after the `await audit(table, +req.params.id, 'update', ...)` line:

```js
      if (table === 'machines') await keepOneDefaultMachine(row);
```

Both go **before** the `res.json(row)` on their respective handlers.

- [ ] **Step 3: Verify against the local database**

Flag the label machine, confirm the board machine loses the flag, then put it back:

```bash
cd "/Users/anikdua/Documents/CI ERP FInal/ci-erp" && node -e "
import('pg').then(async({default:pg})=>{
const c=new pg.Client('postgresql://postgres:postgres@localhost:5439/cierp');await c.connect();
const show=async l=>console.log(l,(await c.query(\"SELECT name,is_default FROM machines WHERE type='cutting' ORDER BY name\")).rows);
await show('before:');
const r=await fetch('http://localhost:4000/api/machines');console.log('api reachable:',r.status);
await c.end();})"
```

Then exercise the real endpoint through the running app (Task 8's UI check covers this end to end). For an isolated check now, flag both rows by hand and confirm the next save collapses them:

```bash
cd "/Users/anikdua/Documents/CI ERP FInal/ci-erp" && node -e "
import('pg').then(async({default:pg})=>{
const c=new pg.Client('postgresql://postgres:postgres@localhost:5439/cierp');await c.connect();
await c.query(\"UPDATE machines SET is_default=1 WHERE type='cutting'\");
console.log('both flagged:',(await c.query(\"SELECT name,is_default FROM machines WHERE type='cutting' ORDER BY name\")).rows);
await c.query(\"UPDATE machines SET is_default=0 WHERE type='cutting' AND name<>'Board Cutting Machine'\");
console.log('restored:',(await c.query(\"SELECT name,is_default FROM machines WHERE type='cutting' ORDER BY name\")).rows);
await c.end();})"
```

Expected: ends with Board Cutting Machine = 1, Automatic Label Cutting Machine = 0.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/masters.js && git commit -m "feat(masters): accept is_default and keep one default machine per category"
```

---

### Task 5: Masters → Machines UI

**Files:**
- Modify: `client/src/pages/Masters.jsx:124-136` (the `machines` config) and the cell renderer near line 510

- [ ] **Step 1: Add the field**

In the `machines` config at `client/src/pages/Masters.jsx:124`, insert between the `status` and `active` fields:

```jsx
      { key: 'is_default', label: 'Default for this station', type: 'select', options: [1, 0], bool: true,
        hint: 'Cutting and Printing start jobs on this machine automatically — one default per category' },
```

`bool: true` is what makes the `[1, 0]` options render as Yes / No (see the select branch at line 692).

- [ ] **Step 2: Add the list column**

In the same config, change:

```js
    columns: ['code', 'name', 'model', 'type', 'operators', 'capacity_per_hour', 'status', 'active'],
```

to:

```js
    columns: ['code', 'name', 'model', 'type', 'is_default', 'operators', 'capacity_per_hour', 'status', 'active'],
```

- [ ] **Step 3: Render the cell**

In the cell renderer, immediately above the existing `if (k === 'active')` line (around line 510):

```jsx
          if (k === 'is_default') return v
            ? <span className="rounded-full bg-brand-100 px-2 py-0.5 text-[11px] font-bold text-brand-700">Default</span>
            : <span className="text-gray-300">—</span>;
```

- [ ] **Step 4: Verify the client still builds**

```bash
cd "/Users/anikdua/Documents/CI ERP FInal/ci-erp" && npm run build -w client
```

Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/Masters.jsx && git commit -m "feat(masters): Default for this station on the machines master"
```

---

### Task 6: The Start modal fills itself

**Files:**
- Modify: `client/src/pages/Section.jsx` — imports, state, the Start button at line 687, `start()` at 311, and the Run assignment panel at 823-847

- [ ] **Step 1: Import the resolver**

Add alongside the other `../lib/…` imports at the top of `client/src/pages/Section.jsx`:

```js
import { autoAssigns, resolveAssignment } from '../lib/runAssignment.js';
```

- [ ] **Step 2: Add the pickers-revealed state**

Next to the other Start-modal state (after `const [machineId, setMachineId] = useState('');` at line 240):

```js
  // Cutting and Printing open with machine + operator already resolved; the
  // dropdowns stay hidden behind Change. Every other station opens on the
  // dropdowns, so this is true there from the moment the modal opens.
  const [showPickers, setShowPickers] = useState(false);
```

- [ ] **Step 3: Resolve when the modal opens**

At line 687, replace:

```jsx
                            onClick={() => { setStarting(r); setOperator(''); setMachineId(data?.machines?.[0]?.id ? String(data.machines[0].id) : ''); setClearance(freshClearance()); }}>
```

with:

```jsx
                            onClick={() => {
                              // Never default to machines[0] — that posted the
                              // alphabetically-first machine of the section and
                              // silently misattributed the run.
                              const a = resolveAssignment(section, r, data?.machines);
                              setStarting(r); setMachineId(a.machineId); setOperator(a.operator);
                              setShowPickers(!a.auto); setClearance(freshClearance());
                            }}>
```

- [ ] **Step 4: Reset the new state when the run starts**

At line 330, change:

```js
    setStarting(null); setOperator(''); setMachineId(''); setShadeAlarm(null);
```

to:

```js
    setStarting(null); setOperator(''); setMachineId(''); setShowPickers(false); setShadeAlarm(null);
```

- [ ] **Step 5: Render the assignment card**

Replace the whole Run assignment `<section>` (lines 823-847) with:

```jsx
            <section className="ci-form-panel">
              <div className="ci-form-panel-title"><span>Run assignment</span><span>{meta.label}</span></div>
              {!showPickers && startMachine ? (
                /* Cutting and Printing arrive decided — the press came from Print
                   Planning, the cutting machine from the master's default flag.
                   Change is always one click away for a breakdown or a relief man. */
                <div className="flex items-center justify-between gap-3 rounded-xl border border-brand-200 bg-brand-50/60 px-3 py-2.5">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-black text-slate-800">{startMachine.name}</div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-xs font-semibold text-slate-600">
                      <User size={11} /> {operator || auth.user?.name}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="rounded-full bg-brand-600 px-2 py-0.5 text-[10px] font-black tracking-wider text-white">AUTO</span>
                    <button type="button" onClick={() => setShowPickers(true)}
                      className="text-xs font-bold text-brand-700 underline decoration-dotted underline-offset-2 hover:text-brand-900">
                      Change
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="ci-form-grid">
                    {(data?.machines || []).length > 0 && (
                      <Field label="Machine">
                        <Select value={machineId} onChange={e => { setMachineId(e.target.value); setOperator(''); }}>
                          {/* Blank first: an unpicked machine must stay unpicked
                              rather than record whichever sorted first. */}
                          <option value="">— Select machine —</option>
                          {data.machines.map(m => <option key={m.id} value={m.id}>{m.name}{m.operators?.length ? ` — ${m.operators.length} operator${m.operators.length > 1 ? 's' : ''}` : ''}</option>)}
                        </Select>
                      </Field>
                    )}
                    <Field label="Operator"
                      hint={machineCrew ? `Assigned crew of ${startMachine.name}` : 'Defaults to your own name if left blank'}>
                      <Select value={operator} onChange={e => setOperator(e.target.value)}>
                        <option value="">— {auth.user?.name} (me) —</option>
                        {(machineCrew || sectionCrew).map(e => <option key={e.id} value={e.name}>{e.name}{e.role && e.role !== 'operator' ? ` (${fmt.title(e.role)})` : ''}</option>)}
                      </Select>
                    </Field>
                  </div>
                  {startMachine && !machineCrew && (
                    <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700">
                      No operators are assigned to {startMachine.name} — showing the whole {meta.label} crew.
                      Assign operators in Masters → Machines to tighten this list.
                    </p>
                  )}
                </>
              )}
            </section>
```

- [ ] **Step 6: Stop the summary panel contradicting the card**

`starting.machine_name` comes from a `COALESCE` that falls back to the job card's **press**, so a cutting job's summary line reads "Offset Printing Press No. 3" — directly contradicting the card below it. At line 820, change:

```jsx
              {starting.machine_name && <> · {starting.machine_name}</>}
```

to:

```jsx
              {/* The assignment card states the machine authoritatively; this
                  fallback reports the job's press, which is wrong at cutting. */}
              {starting.machine_name && (showPickers || !startMachine) && <> · {starting.machine_name}</>}
```

- [ ] **Step 7: Confirm `autoAssigns` is used or drop it from the import**

The import in Step 1 brings in `autoAssigns`. If no other code in this file references it after Step 5, remove it from the import so the build stays clean:

```js
import { resolveAssignment } from '../lib/runAssignment.js';
```

- [ ] **Step 8: Verify the client builds**

```bash
cd "/Users/anikdua/Documents/CI ERP FInal/ci-erp" && npm run build -w client
```

Expected: build succeeds with no unused-import or undefined-variable error.

- [ ] **Step 9: Commit**

```bash
git add client/src/pages/Section.jsx && git commit -m "feat(floor): Cutting and Printing start with machine + operator already filled"
```

---

### Task 7: Audit a press switched at start

**Files:**
- Modify: `server/src/routes/production.js` — the import line and the start handler around line 391

- [ ] **Step 1: Import the helper**

Add `pressOverride` to the existing `./helpers.js` import in `server/src/routes/production.js`. Check the current import first:

```bash
cd "/Users/anikdua/Documents/CI ERP FInal/ci-erp" && grep -n "from './helpers.js'\|from '../helpers.js'" server/src/routes/production.js
```

Add `pressOverride` to that import's brace list.

- [ ] **Step 2: Audit the switch**

In `POST /job-stages/:id/start`, immediately after:

```js
      if (!machineId && st.stage === 'printing' && jc.machine_id) machineId = jc.machine_id;
```

insert:

```js
      // Starting on another press is allowed — a press breaks down, the load
      // shifts — but Print Planning still shows the old one, so say so on the
      // timeline rather than letting the board and the floor drift apart.
      if (pressOverride(st.stage, jc.machine_id, machineId)) {
        const planned = await oc('SELECT name FROM machines WHERE id=$1', [jc.machine_id]);
        const actual = await oc('SELECT name FROM machines WHERE id=$1', [machineId]);
        await audit('job_stage', st.id, 'press_override',
          `Started on ${actual?.name || machineId} — Print Planning assigned ${planned?.name || jc.machine_id}`,
          qc, req.user.name);
      }
```

- [ ] **Step 3: Run the full server suite**

```bash
cd "/Users/anikdua/Documents/CI ERP FInal/ci-erp" && npm test -w server
```

Expected: PASS, `# fail 0`, including the two new test files.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/production.js && git commit -m "feat(production): audit a printing run started on a press other than planned"
```

---

### Task 8: Verify in the real running app

The project's rule is that UI passes are judged in the real app at a desktop breakpoint, logged in — never a mock.

- [ ] **Step 1: Run the full verification**

```bash
cd "/Users/anikdua/Documents/CI ERP FInal/ci-erp" && npm run verify
```

Expected: baseline fresh, server tests pass, client build succeeds.

- [ ] **Step 2: Start the app and log in**

```bash
cd "/Users/anikdua/Documents/CI ERP FInal/ci-erp" && npm run dev
```

Use `preview_start` with `{name: "ci-erp"}`, then log in as `admin@motionci.com` / `admin123`.

- [ ] **Step 3: Check Cutting**

Open Floor → Cutting, click Start on a queued job. Confirm: the Run assignment panel shows one card reading **Board Cutting Machine · Ankit** with an AUTO chip, the summary line above it does **not** name a printing press, and **Change** reveals two working dropdowns.

- [ ] **Step 4: Check Printing**

Open Floor → Printing and start a job that Print Planning assigned to a press. Confirm the card names **that** press and its operator — not Press No. 1 by default.

- [ ] **Step 5: Check a manual station**

Open Floor → Coating (or Die Cutting) and click Start. Confirm the dropdowns show, and that Machine opens on **— Select machine —** rather than a pre-picked machine.

- [ ] **Step 6: Confirm what was recorded**

After starting one cutting job, check it landed on the right machine:

```bash
cd "/Users/anikdua/Documents/CI ERP FInal/ci-erp" && node -e "
import('pg').then(async({default:pg})=>{
const c=new pg.Client('postgresql://postgres:postgres@localhost:5439/cierp');await c.connect();
const r=await c.query(\"SELECT js.id, js.stage, js.operator, m.name machine, js.started_at FROM job_stages js LEFT JOIN machines m ON m.id=js.machine_id WHERE js.stage IN ('cutting','printing') AND js.started_at IS NOT NULL ORDER BY js.started_at DESC LIMIT 5\");
console.table(r.rows);await c.end();})"
```

Expected: the newest cutting row shows `Board Cutting Machine` / `Ankit`.

- [ ] **Step 7: Screenshot the before/after for the owner**

Take a screenshot of the filled Cutting start modal — the at-a-glance difference (two empty dropdowns → one decided card) is how this change gets judged.

---

## Self-review notes

Checked against the spec:

- Resolution rules (machine 1-5, operator 1-3) → Task 1, one test per rule including the out-of-scope-press fall-through.
- `is_default` column, guarded seed, baseline regen → Task 3.
- One default per category → Task 4.
- Masters field + column → Task 5.
- Assignment card, AUTO chip, Change, fallback to plain dropdowns → Task 6.
- Blank option at manual stations → Task 6 Step 5. **Deviation from the spec, deliberate:** the blank is rendered at *every* station, not only the manual ones. A revealed picker in an auto section needs a way to clear a wrong machine, and one unconditional option is simpler than a conditional one. Auto sections resolve to a non-empty `machineId`, so the blank is never the selected value there.
- `press_override` audit → Tasks 2 and 7.
- Summary-panel contradiction → Task 6 Step 6. Not in the spec; found while planning, because `machine_name` falls back to the job's press and would have contradicted the new card at cutting.
- Line clearance stays mandatory and untouched — no task modifies it.

Names used consistently throughout: `autoAssigns`, `resolveMachine`, `resolveOperator`, `resolveAssignment`, `AUTO_ASSIGN_SECTIONS`, `pressOverride`, `keepOneDefaultMachine`, `showPickers`, `startMachine`, `machineCrew`.
