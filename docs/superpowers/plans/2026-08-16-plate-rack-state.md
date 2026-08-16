# Plate Rack State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a planner take a rack plate out of circulation with a reason, put it back (including un-retiring a scrapped one), and undo a set-aside in one click.

**Architecture:** Every decision is a pure function in `server/src/plates.js`; routes hold only SQL and the transaction. The reason→state mapping has ONE home in `client/src/lib/plateRack.js`, imported by the server — `server/src/helpers.js` already imports `client/src/lib/productCode.js`, so this direction is established and avoids a client twin. Set aside changes `status` alone, which is what makes Undo exact.

**Tech Stack:** Node ESM, Express, node:test, Postgres (`pg`), React 18, Tailwind. Workspaces: `server`, `client`.

**Worktree:** `/private/tmp/claude-501/-Users-anikdua-Documents-Projects-Colour-Imp-Production/407ec36d-f9aa-4d77-a9f3-54375e98be06/scratchpad/wt-rackpick`, branch `feat/plate-rack-picker`.

**Spec:** `docs/superpowers/specs/2026-08-16-plate-rack-state-design.md`

---

## Standing rule: no commits, no push, no deploy

This directory's `CLAUDE.md` forbids all three unless Anik sanctions it **in the session where it happens**. The sanction he gave for the rack picker does NOT carry to this work. Every task ends in a **Checkpoint** — run the gate, confirm green, stop — naming what a commit would have staged so it converts back verbatim if he sanctions it.

## Read before writing any test

**No test in this repo touches a database.** Two idioms only:

1. **Pure unit tests** — import from `plates.js`, assert on the return. Validators throw `Object.assign(new Error(msg), { status })`.
2. **Source-text tests** — `readFileSync` the route/component and `assert.match`. **A slice anchored on a name silently passes against the WRONG function when the anchor moves, or slices to `''` and asserts nothing — always `assert.ok(body.length > N)` first.**

Client `lib` logic is tested from a **server** test file that imports across the workspace (`server/src/board-math.test.js` is the precedent).

Gate: `npm test -w server`. Never `node --test src/*.test.js`. Full gate: `npm run verify`.

## Structured errors go under `body`

`app.js:80` writes `{ error: err.message, ...(err.body || {}) }` — **`err.body` and nothing else**. A `code` on the error itself is dropped and the page keying on it becomes a dead button. `server/src/structured-errors.test.js` guards six keys (`code`, `at`, `blockers`, `conflicts`, `existing`, `incoming`). Use `{ status: 409, body: { code: 'X' } }`; assert `error.body.code`. **Never `err.code = …` after the literal to dodge the regex.**

## File structure

| File | Responsibility | Change |
|---|---|---|
| `client/src/lib/plateRack.js` | Pure client rack logic; **sole home of the reason table** | Modify — add `PLATE_SET_ASIDE_REASONS` |
| `server/src/plates.js` | Pure plate logic, no I/O | Modify — add `validateSetAside`, `validateMakeAvailable`, `invertMovement` |
| `server/src/routes/plates.js` | HTTP + transactions | Modify — 3 new routes |
| `client/src/components/RackPickerModal.jsx` | The picker | Modify — per-row Set aside (not Retire; see Task 6) |
| `client/src/components/PlatesLifecycle.jsx` | Warehouse + Plate PR page | Modify — third tab, actions, handlers |
| `server/src/plate-rack-state.test.js` | **All tests for this feature** | **Create** |

A new test file rather than growing `plate-rack-reuse.test.js`, which is already ~700 lines and covers a different feature.

---

### Task 1: The reason table, in one place

**Files:**
- Modify: `client/src/lib/plateRack.js`
- Create: `server/src/plate-rack-state.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/src/plate-rack-state.test.js`:

```js
// Taking a rack plate out of circulation, putting it back, and undoing the first.
//
// Set aside changes STATUS ONLY. condition is a physical grade produced by
// inspecting the plate — the return-verification flow does that. A planner
// flagging a plate from the picker has not inspected it, and the status
// 'damaged' already says what they mean. Writing condition='Damaged' there would
// be the system asserting a grade nobody checked; it is also what would make
// Undo impossible, since plate_asset_movements records only the RESULTING
// condition and has no from_condition to restore.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PLATE_SET_ASIDE_REASONS, PLATE_RETIRE_REASONS } from '../../client/src/lib/plateRack.js';

const root = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

test('every set-aside reason names a status the database already allows', () => {
  // Exactly the four in the spec, in offer order.
  assert.deepEqual(PLATE_SET_ASIDE_REASONS.map(row => row.key),
    ['damaged', 'missing', 'check', 'other']);
  // Live CHECK constraints, verified against production before this was designed.
  const STATUSES = ['damaged', 'lost', 'awaiting_verification'];
  const ACTIONS = ['damaged', 'not_found', 'verification_requested'];
  for (const row of PLATE_SET_ASIDE_REASONS) {
    assert.ok(row.label, `${row.key} needs a label the planner can read`);
    assert.ok(STATUSES.includes(row.status), `${row.key} → ${row.status} is not an allowed status`);
    assert.ok(ACTIONS.includes(row.action), `${row.key} → ${row.action} is not an allowed movement action`);
    // No reason may re-grade the plate. See the header.
    assert.ok(!('condition' in row), `${row.key} must not set a condition`);
  }
});

test('set-aside reasons are not the retire reasons', () => {
  // Retire asks why a plate is DEAD ("Worn out — dot loss", "Artwork changed").
  // Set aside asks why it is off the rack TODAY. Sharing the list would offer
  // "Artwork changed" as a temporary state and "Can't find it" as a scrap reason.
  const retire = new Set(PLATE_RETIRE_REASONS);
  const overlap = PLATE_SET_ASIDE_REASONS.filter(row => retire.has(row.label));
  assert.deepEqual(overlap.map(row => row.label), ['Damaged'],
    'only Damaged legitimately appears in both lists');
});

test('the reason table has one home, and the server reads it from there', () => {
  const plates = read('server/src/plates.js');
  assert.match(plates, /from '\.\.\/\.\.\/client\/src\/lib\/plateRack\.js'/);
  assert.match(plates, /PLATE_SET_ASIDE_REASONS/);
  // Not re-declared server-side — a twin is a thing to keep in step.
  assert.doesNotMatch(plates, /const PLATE_SET_ASIDE_REASONS\s*=\s*\[/);
});
```

- [ ] **Step 2: Run it and confirm it FAILS**

`npm test -w server` — expect the file to fail at load: `SyntaxError: … does not provide an export named 'PLATE_SET_ASIDE_REASONS'`. That is ESM's failure mode for a missing named export, not a per-test error.

- [ ] **Step 3: Add the table**

Append to `client/src/lib/plateRack.js`, after `PLATE_RETIRE_REASONS`:

```js
// Why a plate is coming OFF the rack today — a different question from
// PLATE_RETIRE_REASONS above, which asks why a plate is dead. Sharing that list
// would offer "Artwork changed" as a temporary state and "Can't find it" as a
// reason to scrap.
//
// This is the only copy. server/src/plates.js imports it from here, the same
// direction server/src/helpers.js already imports productCode.js — one home
// beats a twin that has to be kept in step.
//
// No entry carries a condition: setting a plate aside records WHERE it stands,
// never re-grades it. Grading is what inspection does.
export const PLATE_SET_ASIDE_REASONS = [
  { key: 'damaged', label: 'Damaged',        status: 'damaged',               action: 'damaged' },
  { key: 'missing', label: "Can't find it",  status: 'lost',                  action: 'not_found' },
  { key: 'check',   label: 'Needs checking', status: 'awaiting_verification', action: 'verification_requested' },
  { key: 'other',   label: 'Other',          status: 'awaiting_verification', action: 'verification_requested' },
];
```

- [ ] **Step 4: Import it server-side**

At the top of `server/src/plates.js`, beside the existing imports:

```js
import { PLATE_SET_ASIDE_REASONS } from '../../client/src/lib/plateRack.js';
```

If this leaves the import unused until Task 2, that is expected — Task 2 consumes it. Confirm `node --check server/src/plates.js` is clean.

- [ ] **Step 5: Run — expect 3 tests PASS**

`npm test -w server -- --test-name-pattern="set-aside reason|not the retire reasons|one home"`

- [ ] **Step 6: Run the WHOLE suite**

`npm test -w server`. Record the number; every later task compares against it.

- [ ] **Step 7: Checkpoint — DO NOT COMMIT**

Would stage: `client/src/lib/plateRack.js`, `server/src/plates.js`, `server/src/plate-rack-state.test.js`
Message: `feat: one table maps a set-aside reason to a plate state`

---

### Task 2: `validateSetAside`

**Files:**
- Modify: `server/src/plates.js` (after `pickAvailableRackPlates`, currently line 504-523)
- Test: `server/src/plate-rack-state.test.js`

- [ ] **Step 1: Write the failing test**

Append to `server/src/plate-rack-state.test.js`, adding `validateSetAside` to the `./plates.js` import (create that import block if this is the first server import in the file):

```js
const plate = (id, extra = {}) => ({
  id, asset_number: `CI-PL-A-${String(id).padStart(4, '0')}`,
  status: extra.status || 'available', condition: extra.condition || 'Good',
  rack_location: extra.rack_location || 'Used Plates Rack',
});

test('setting a plate aside resolves the reason to a status and an action', () => {
  const out = validateSetAside({ rackAssets: [plate(1)], assetIds: [1], reason: 'damaged' });
  assert.deepEqual(out.picked.map(row => row.id), [1]);
  assert.equal(out.rule.status, 'damaged');
  assert.equal(out.rule.action, 'damaged');
});

test('an unknown or missing reason is refused before anything is touched', () => {
  for (const reason of [undefined, '', 'nonsense', 'Damaged']) {
    assert.throws(() => validateSetAside({ rackAssets: [plate(1)], assetIds: [1], reason }),
      error => error.status === 400,
      `reason ${JSON.stringify(reason)} should be refused — the table is keyed by key, not label`);
  }
});

// The rule that protects the floor. Setting aside a plate a job card is relying
// on strands that job silently, so it uses the SAME guard Retire uses rather
// than re-spelling it.
test('a plate a job owns can never be set aside, and the refusal names it', () => {
  for (const status of ['reserved', 'issued_to_printing', 'returned_pending_verification']) {
    assert.throws(() => validateSetAside({
      rackAssets: [plate(1, { status })], assetIds: [1], reason: 'damaged',
    }), error => error.status === 409 && /CI-PL-A-0001/.test(error.message),
    `${status} must be refused by name`);
  }
});

test('a plate that is not on this rack at all is refused', () => {
  assert.throws(() => validateSetAside({ rackAssets: [plate(1)], assetIds: [99], reason: 'damaged' }),
    error => error.status === 409);
});

test('set aside goes through the same guard as retire, not a second spelling', () => {
  const plates = read('server/src/plates.js');
  const fn = plates.slice(plates.indexOf('export function validateSetAside'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.ok(body.length > 100, 'validateSetAside not found — the anchor moved');
  assert.match(body, /pickAvailableRackPlates\(/);
  // No hand-rolled copy of the in-flight rule.
  assert.doesNotMatch(body, /issued_to_printing/);
});
```

- [ ] **Step 2: Run and confirm it FAILS**

- [ ] **Step 3: Implement**

Add to `server/src/plates.js` immediately after `pickAvailableRackPlates`:

```js
const SET_ASIDE_BY_KEY = new Map(PLATE_SET_ASIDE_REASONS.map(row => [row.key, row]));

// Taking a plate off the rack for now — damaged, missing, or wanting a look —
// without scrapping it.
//
// The in-flight check is pickAvailableRackPlates, the same one Retire uses,
// deliberately: a plate a job card is relying on must never leave the rack
// underneath it, and two spellings of that rule would drift apart.
//
// Keyed by `key`, never by the label the screen shows, so re-wording a button
// can never change what it does.
export function validateSetAside({ rackAssets = [], assetIds = [], reason } = {}) {
  const rule = SET_ASIDE_BY_KEY.get(String(reason ?? '').trim());
  if (!rule) {
    throw Object.assign(new Error('Choose why this plate is coming off the rack'), { status: 400 });
  }
  return { picked: pickAvailableRackPlates({ rackAssets, assetIds }), rule };
}
```

- [ ] **Step 4: Run — expect 5 tests PASS**

- [ ] **Step 5: Run the WHOLE suite** — no regressions.

- [ ] **Step 6: Checkpoint — DO NOT COMMIT**

Would stage: `server/src/plates.js`, `server/src/plate-rack-state.test.js`
Message: `feat: validateSetAside reuses the guard that protects in-flight plates`

---

### Task 3: `validateMakeAvailable`

**Files:**
- Modify: `server/src/plates.js` (after `validateSetAside`)
- Test: `server/src/plate-rack-state.test.js`

- [ ] **Step 1: Write the failing test**

Append, adding `validateMakeAvailable` and `PLATE_RESTORABLE_STATUSES` to the `./plates.js` import:

```js
test('a set-aside plate comes back with the condition the planner stated', () => {
  const out = validateMakeAvailable({
    rackAssets: [plate(1, { status: 'damaged' })], assetIds: [1], condition: 'Fair',
  });
  assert.deepEqual(out.map(row => row.id), [1]);
});

test('every set-aside state and scrapped can be restored', () => {
  assert.deepEqual(PLATE_RESTORABLE_STATUSES,
    ['damaged', 'lost', 'awaiting_verification', 'scrapped']);
  for (const status of PLATE_RESTORABLE_STATUSES) {
    const out = validateMakeAvailable({
      rackAssets: [plate(1, { status })], assetIds: [1], condition: 'Good',
    });
    assert.equal(out.length, 1, `${status} should be restorable`);
  }
});

// A plate whose condition reads 'Scrapped' must not come back as Good because
// nobody chose. There is no default here on purpose.
test('bringing a plate back without stating its condition is refused', () => {
  for (const condition of [undefined, '', 'Good ', 'Damaged', 'Scrapped']) {
    assert.throws(() => validateMakeAvailable({
      rackAssets: [plate(1, { status: 'scrapped' })], assetIds: [1], condition,
    }), error => error.status === 400,
    `condition ${JSON.stringify(condition)} should be refused — only Good or Fair`);
  }
});

test('a plate already on the rack, or in flight, is not restorable', () => {
  for (const status of ['available', 'reserved', 'issued_to_printing']) {
    assert.throws(() => validateMakeAvailable({
      rackAssets: [plate(1, { status })], assetIds: [1], condition: 'Good',
    }), error => error.status === 409 && /CI-PL-A-0001/.test(error.message),
    `${status} must be refused by name`);
  }
});

test('restoring nothing is refused rather than reported as success', () => {
  assert.throws(() => validateMakeAvailable({ rackAssets: [plate(1)], assetIds: [], condition: 'Good' }),
    error => error.status === 400);
});
```

- [ ] **Step 2: Run and confirm it FAILS**

- [ ] **Step 3: Implement**

Add to `server/src/plates.js` immediately after `validateSetAside`:

```js
export const PLATE_SET_ASIDE_STATUSES = ['damaged', 'lost', 'awaiting_verification'];
// Scrapped is here because un-retiring is allowed — see the design note. It is
// the one restorable state that also has to clear active=0, which the route does.
export const PLATE_RESTORABLE_STATUSES = [...PLATE_SET_ASIDE_STATUSES, 'scrapped'];

const RESTORE_CONDITIONS = ['Good', 'Fair'];

// Putting a plate back on the rack, including bringing back one that was
// retired.
//
// The condition is REQUIRED and has no default. A scrapped plate's condition
// reads 'Scrapped'; letting it return as 'Good' because nobody chose would put
// an invented grade on a plate the floor prints from. The movements table stores
// only the resulting condition, so there is no earlier value to restore either.
export function validateMakeAvailable({ rackAssets = [], assetIds = [], condition } = {}) {
  const wanted = [...new Set((Array.isArray(assetIds) ? assetIds : []).map(Number))].filter(Boolean);
  if (!wanted.length) {
    throw Object.assign(new Error('Tick at least one plate'), { status: 400 });
  }
  if (!RESTORE_CONDITIONS.includes(condition)) {
    throw Object.assign(new Error('Say what condition the plate is in — Good or Fair'), { status: 400 });
  }
  const byId = new Map((Array.isArray(rackAssets) ? rackAssets : []).map(row => [Number(row.id), row]));
  const stranger = wanted.find(id => !byId.has(id));
  if (stranger) {
    throw Object.assign(new Error(`Plate ${stranger} is not in this rack`), { status: 409 });
  }
  const busy = wanted.map(id => byId.get(id))
    .find(row => !PLATE_RESTORABLE_STATUSES.includes(row.status));
  if (busy) {
    throw Object.assign(
      new Error(`${busy.asset_number || `Plate ${busy.id}`} is not set aside — it is ${String(busy.status).replace(/_/g, ' ')}`),
      { status: 409 });
  }
  return wanted.map(id => byId.get(id));
}
```

- [ ] **Step 4: Run — expect 5 tests PASS**

- [ ] **Step 5: Run the WHOLE suite**

- [ ] **Step 6: Checkpoint — DO NOT COMMIT**

Would stage: `server/src/plates.js`, `server/src/plate-rack-state.test.js`
Message: `feat: a plate comes back only with a condition somebody chose`

---

### Task 4: `invertMovement`

**Files:**
- Modify: `server/src/plates.js` (after `validateMakeAvailable`)
- Test: `server/src/plate-rack-state.test.js`

- [ ] **Step 1: Write the failing test**

Append, adding `invertMovement` to the `./plates.js` import:

```js
const movement = (extra = {}) => ({
  id: 7, plate_asset_id: 1, action: 'damaged',
  from_status: 'available', to_status: 'damaged',
  from_location: 'Used Plates Rack', to_location: 'Used Plates Rack',
  tooling_request_id: null, job_card_id: null, ...extra,
});

test('undoing a set-aside restores where the plate was, and nothing else', () => {
  const out = invertMovement({
    movement: movement(), asset: plate(1, { status: 'damaged' }),
  });
  assert.equal(out.status, 'available');
  assert.equal(out.rack_location, 'Used Plates Rack');
  assert.equal(out.active, 1);
  // Set aside never changed the grade, so undo has nothing to put back — and the
  // movements table has no from_condition it could read anyway.
  assert.ok(!('condition' in out), 'undo must not write a condition');
});

// action alone cannot tell these apart: releaseDraftPlateAssets writes
// 'adjustment' too, and so do the PR edit and delete paths. Reversing one of
// those here would re-reserve a plate against a job that no longer wants it.
test('a movement belonging to a job card is not undoable here', () => {
  for (const extra of [{ tooling_request_id: 5 }, { job_card_id: 9 }]) {
    assert.throws(() => invertMovement({
      movement: movement({ action: 'adjustment', ...extra }),
      asset: plate(1, { status: 'damaged' }),
    }), error => error.status === 409 && error.body.code === 'MOVEMENT_NOT_UNDOABLE');
  }
});

test('only the three set-aside actions can be undone', () => {
  for (const action of ['damaged', 'not_found', 'verification_requested']) {
    const out = invertMovement({
      movement: movement({ action, to_status: 'damaged' }),
      asset: plate(1, { status: 'damaged' }),
    });
    assert.equal(out.status, 'available', `${action} should be undoable`);
  }
  // 'scrapped' is reversed by Return to rack, which asks for the condition;
  // 'adjustment' and 'reserved' belong to other flows entirely.
  for (const action of ['scrapped', 'adjustment', 'reserved', 'issued', 'returned']) {
    assert.throws(() => invertMovement({
      movement: movement({ action }), asset: plate(1, { status: 'damaged' }),
    }), error => error.status === 409 && error.body.code === 'MOVEMENT_NOT_UNDOABLE',
    `${action} must not be undoable here`);
  }
});

test('a plate that has moved on since is refused by name, not overwritten', () => {
  assert.throws(() => invertMovement({
    movement: movement(),                       // left the plate at 'damaged'
    asset: plate(1, { status: 'reserved' }),    // but it is reserved now
  }), error => error.status === 409
    && error.body.code === 'MOVEMENT_SUPERSEDED'
    && /CI-PL-A-0001/.test(error.message)
    && /reserved/.test(error.message));
});

test('undoing a movement whose record is gone is refused', () => {
  assert.throws(() => invertMovement({ movement: null, asset: plate(1) }),
    error => error.status === 404);
  assert.throws(() => invertMovement({ movement: movement(), asset: null }),
    error => error.status === 404);
});
```

- [ ] **Step 2: Run and confirm it FAILS**

- [ ] **Step 3: Implement**

Add to `server/src/plates.js` immediately after `validateMakeAvailable`:

```js
// The set-aside actions, and ONLY those, can be undone by replaying a movement
// backwards. Retire is reversed by Return to rack, which asks for the condition
// the record cannot supply; 'adjustment' is deliberately absent because
// releaseDraftPlateAssets writes it too.
const UNDOABLE_SET_ASIDE_ACTIONS = PLATE_SET_ASIDE_REASONS.map(row => row.action);

// Undo, expressed as the inverse of one movement rather than as new state.
//
// Restores status and location only. Set aside never changed the grade, so there
// is nothing to put back — and plate_asset_movements holds a single `condition`
// column recording what the movement RESULTED in, with no from_condition, so a
// grade could not be restored even if one had changed.
export function invertMovement({ movement, asset } = {}) {
  if (!movement || !asset) {
    throw Object.assign(new Error('That change is no longer on record'), { status: 404 });
  }
  // A job-linked movement belongs to a reservation or an issue and has its own
  // reversal path. The action cannot discriminate — 'adjustment' is written by
  // this feature AND by releaseDraftPlateAssets — but the ids can.
  if (movement.tooling_request_id || movement.job_card_id) {
    throw Object.assign(
      new Error('That change belongs to a job card — undo it from the requirement, not the rack'),
      { status: 409, body: { code: 'MOVEMENT_NOT_UNDOABLE' } });
  }
  if (!UNDOABLE_SET_ASIDE_ACTIONS.includes(movement.action)) {
    throw Object.assign(
      new Error('That change cannot be undone here — bring the plate back from the Set aside tab instead'),
      { status: 409, body: { code: 'MOVEMENT_NOT_UNDOABLE' } });
  }
  if (String(asset.status) !== String(movement.to_status)) {
    throw Object.assign(
      new Error(`${asset.asset_number} has changed since — it is now ${String(asset.status).replace(/_/g, ' ')}`),
      { status: 409, body: { code: 'MOVEMENT_SUPERSEDED' } });
  }
  return {
    status: movement.from_status,
    rack_location: movement.from_location,
    active: movement.from_status === 'scrapped' ? 0 : 1,
  };
}
```

- [ ] **Step 4: Run — expect 5 tests PASS**

- [ ] **Step 5: Run the WHOLE suite**

- [ ] **Step 6: Checkpoint — DO NOT COMMIT**

Would stage: `server/src/plates.js`, `server/src/plate-rack-state.test.js`
Message: `feat: undo a set-aside by replaying its movement backwards`

---

### Task 5: The three routes

**Files:**
- Modify: `server/src/routes/plates.js` (insert after the `retire` route, currently line 1616-1641)
- Test: `server/src/plate-rack-state.test.js`

- [ ] **Step 1: Write the failing test**

Append:

```js
const routeBody = (route, start, end) => {
  const fn = route.slice(route.indexOf(start));
  return fn.slice(0, end ? fn.indexOf(end) : undefined);
};

test('set aside writes status only, and never a condition', () => {
  const route = read('server/src/routes/plates.js');
  const body = routeBody(route, "r.post('/plates/assets/set-aside'", "\nr.post('/plates/assets/make-available'");
  assert.ok(body.length > 400, 'set-aside route not found — the anchor moved');
  assert.match(body.slice(0, 120), /set-aside', canVerify/);
  assert.match(body, /validateSetAside\(/);
  // Status only. Re-grading a plate nobody inspected is what this must not do.
  assert.doesNotMatch(body, /SET status=\$1,condition=/);
  assert.match(body, /movement_ids/);
});

test('make available clears active so an un-retired plate is really back', () => {
  const route = read('server/src/routes/plates.js');
  const body = routeBody(route, "r.post('/plates/assets/make-available'", "\nr.post('/plates/assets/undo-movement'");
  assert.ok(body.length > 400, 'make-available route not found — the anchor moved');
  assert.match(body.slice(0, 130), /make-available', canVerify/);
  assert.match(body, /validateMakeAvailable\(/);
  // A scrapped plate carries active=0 and rack 'Scrap'; both have to be undone
  // or the plate is "available" and still invisible to every rack query.
  assert.match(body, /active=1/);
  assert.match(body, /USED_PLATES_RACK|Used Plates Rack/);
});

test('undo refuses by name and says so in a code the page can read', () => {
  const route = read('server/src/routes/plates.js');
  const body = routeBody(route, "r.post('/plates/assets/undo-movement'", "\nr.get('/plates/sets/history'");
  assert.ok(body.length > 300, 'undo-movement route not found — the anchor moved');
  assert.match(body.slice(0, 130), /undo-movement', canVerify/);
  assert.match(body, /invertMovement\(/);
  assert.match(body, /FOR UPDATE/);
  // Undo is an event in the ledger, never an erasure of one.
  assert.match(body, /INSERT INTO plate_asset_movements/);
});
```

- [ ] **Step 2: Run and confirm it FAILS**

- [ ] **Step 3: Implement**

Add `validateSetAside, validateMakeAvailable, invertMovement` to the existing import block from `'../plates.js'` in `server/src/routes/plates.js`. Insert all three routes immediately after the `retire` route.

```js
// Take a plate off the rack for now — damaged, missing, or wanting a look —
// without scrapping it. STATUS ONLY: grading a plate is what inspection does,
// and leaving the grade alone is also what lets Undo be exact.
r.post('/plates/assets/set-aside', canVerify, async (req, res, next) => {
  try {
    const result = await tx(async (qc) => {
      const ids = [...new Set((req.body.asset_ids || []).map(Number))].filter(Boolean);
      const rackAssets = await qc('SELECT * FROM plate_assets WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE', [ids]);
      const { picked, rule } = validateSetAside({ rackAssets, assetIds: ids, reason: req.body.reason });
      const note = String(req.body.note || '').trim() || rule.label;
      const movement_ids = [];
      for (const asset of picked) {
        await qc('UPDATE plate_assets SET status=$1,updated_at=now() WHERE id=$2', [rule.status, asset.id]);
        const [row] = await qc(`INSERT INTO plate_asset_movements
          (plate_asset_id,action,from_status,to_status,from_location,to_location,condition,note,user_name)
          VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8) RETURNING id`,
        [asset.id, rule.action, asset.status, rule.status, asset.rack_location,
         asset.condition, `Set aside — ${note}`, req.user.name]);
        movement_ids.push(row.id);
        await audit('plate_asset', asset.id, 'set_aside',
          `${asset.asset_number} set aside — ${note}`, qc, req.user.name);
      }
      return { set_aside: picked.length, plates: picked.map(row => row.asset_number), movement_ids };
    });
    res.json(result);
  } catch (error) { next(error); }
});

// Put a plate back on the rack — including one that was retired. The condition
// is stated by the planner, never defaulted: see validateMakeAvailable.
r.post('/plates/assets/make-available', canVerify, async (req, res, next) => {
  try {
    const result = await tx(async (qc) => {
      const ids = [...new Set((req.body.asset_ids || []).map(Number))].filter(Boolean);
      const rackAssets = await qc('SELECT * FROM plate_assets WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE', [ids]);
      const picked = validateMakeAvailable({ rackAssets, assetIds: ids, condition: req.body.condition });
      const note = String(req.body.reason || '').trim();
      if (!note) throw Object.assign(new Error('Say why this plate is going back on the rack'), { status: 400 });
      for (const asset of picked) {
        // A retired plate carries active=0 and rack 'Scrap'. Both must be undone
        // or it reads 'available' while staying invisible to every rack query.
        // It returns to the USED rack: recovered stock is not fresh stock.
        const location = asset.status === 'scrapped' ? USED_PLATES_RACK : asset.rack_location;
        await qc(`UPDATE plate_assets SET status='available',condition=$1,rack_location=$2,
          active=1,updated_at=now() WHERE id=$3`, [req.body.condition, location, asset.id]);
        await qc(`INSERT INTO plate_asset_movements
          (plate_asset_id,action,from_status,to_status,from_location,to_location,condition,note,user_name)
          VALUES ($1,'adjustment',$2,'available',$3,$4,$5,$6,$7)`,
        [asset.id, asset.status, asset.rack_location, location, req.body.condition,
         `${asset.status === 'scrapped' ? 'Returned to rack' : 'Made available'} — ${note}`, req.user.name]);
        await audit('plate_asset', asset.id, 'make_available',
          `${asset.asset_number} back on the rack as ${req.body.condition} — ${note}`, qc, req.user.name);
      }
      return { restored: picked.length, plates: picked.map(row => row.asset_number) };
    });
    res.json(result);
  } catch (error) { next(error); }
});

// Undo a set-aside: replay its movement backwards. The undo is itself a movement
// row — the ledger gains an event, it never loses one.
r.post('/plates/assets/undo-movement', canVerify, async (req, res, next) => {
  try {
    const result = await tx(async (qc, oc) => {
      const movementId = Number(req.body.movement_id);
      if (!movementId) throw Object.assign(new Error('Which change should be undone?'), { status: 400 });
      const movement = await oc('SELECT * FROM plate_asset_movements WHERE id=$1', [movementId]);
      const asset = movement
        ? await oc('SELECT * FROM plate_assets WHERE id=$1 FOR UPDATE', [movement.plate_asset_id])
        : null;
      const restore = invertMovement({ movement, asset });
      await qc(`UPDATE plate_assets SET status=$1,rack_location=$2,active=$3,updated_at=now()
        WHERE id=$4`, [restore.status, restore.rack_location, restore.active, asset.id]);
      await qc(`INSERT INTO plate_asset_movements
        (plate_asset_id,action,from_status,to_status,from_location,to_location,condition,note,user_name)
        VALUES ($1,'adjustment',$2,$3,$4,$5,$6,$7,$8)`,
      [asset.id, asset.status, restore.status, asset.rack_location, restore.rack_location,
       asset.condition, `Undid: ${movement.note || movement.action}`, req.user.name]);
      await audit('plate_asset', asset.id, 'undo_movement',
        `${asset.asset_number} — undid ${movement.action}`, qc, req.user.name);
      return { plate: asset.asset_number, status: restore.status };
    });
    res.json(result);
  } catch (error) { next(error); }
});
```

**Check before writing:** `USED_PLATES_RACK` is already imported in this file (Task 1 of the picker plan used it). Confirm with `grep -n "USED_PLATES_RACK" server/src/routes/plates.js`. `audit` and `tx` are already in scope — the neighbouring `retire` route uses both.

- [ ] **Step 4: Run — expect 3 tests PASS**

- [ ] **Step 5: Run the WHOLE suite**

If `structured-errors.test.js` fails, a `code` was put on an error instead of under `body`. Fix the code, not the guard.

- [ ] **Step 6: Checkpoint — DO NOT COMMIT**

Would stage: `server/src/routes/plates.js`, `server/src/plate-rack-state.test.js`
Message: `feat: set aside, make available and undo a rack plate`

---

### Task 6: Set aside and Retire from the picker

**Files:**
- Modify: `client/src/components/RackPickerModal.jsx`
- Test: `server/src/plate-rack-state.test.js`

- [ ] **Step 1: Write the failing test**

Append:

```js
test('the picker can take a plate off the rack, but not the one the line holds', () => {
  const modal = read('client/src/components/RackPickerModal.jsx');
  assert.match(modal, /PLATE_SET_ASIDE_REASONS/);
  assert.match(modal, /Set aside/);
  // The row flagged current is the plate this line already holds, and it is
  // 'reserved' — offering Set aside there walks the planner into the in-flight
  // guard for a 409 they could have been spared.
  assert.match(modal, /!row\.current/);
  // The modal decides nothing: the reason table and the payload shape are the
  // tested lib's job.
  assert.match(modal, /from '\.\.\/lib\/plateRack\.js'/);
});
```

- [ ] **Step 2: Run and confirm it FAILS**

- [ ] **Step 3: Read the row markup first**

`sed -n '/candidates.map/,/^                  );/p' client/src/components/RackPickerModal.jsx`

The candidate row is a `<label>` wrapping a radio, with a flex layout: radio, a `min-w-0 flex-1` span of identity, then a `shrink-0 text-right` stat column. Add the action affordance **inside the row, after the stat column, outside the label's clickable identity area** — a `<label>` wrapping a button makes the button toggle the radio.

**This means the row can no longer be a single `<label>`.** Restructure to a `<div className="flex …">` containing the `<label>` (radio + identity + stats) and the action button as a sibling. Keep every existing class name so the row looks unchanged.

- [ ] **Step 4: Implement**

Add to the imports:

```js
import { defaultPickSelection, duplicatePickAssets, pickPayload, PLATE_SET_ASIDE_REASONS } from '../lib/plateRack.js';
```

Add a prop `onSetAside` to the component signature, and per candidate row (only when `!row.current`) a small ghost button that opens an inline reason row:

```jsx
{!row.current && (
  <button type="button"
    className="shrink-0 rounded-full px-2 py-1 text-[10px] font-bold text-slate-400 hover:bg-slate-100 hover:text-slate-700"
    onClick={() => setAsideFor(asideFor === row.id ? null : row.id)}>
    Not this one
  </button>
)}
```

and, when `asideFor === row.id`, a reason strip beneath it:

```jsx
{asideFor === row.id && (
  <div className="flex flex-wrap items-center gap-1 border-b border-slate-100 pb-2">
    <span className="text-[10px] font-bold text-slate-500">Take {row.asset_number} off the rack —</span>
    {PLATE_SET_ASIDE_REASONS.map(reason => (
      <button key={reason.key} type="button"
        className="rounded-full border border-slate-200 px-2 py-0.5 text-[10px] font-bold text-slate-600 hover:border-slate-400"
        onClick={() => { setAsideFor(null); onSetAside(row.id, reason.key); }}>
        {reason.label}
      </button>
    ))}
  </div>
)}
```

`const [asideFor, setAsideFor] = useState(null);` beside the existing state. The reason IS the confirmation — there is no second dialog, and no state change happens on the first tap.

**Retire is deliberately NOT offered here.** Retire is permanent and its reasons are a different list; a modal whose job is picking a plate is the wrong place to scrap one. The picker offers Set aside; the warehouse offers Retire, as it does today.

- [ ] **Step 5: Run — expect the test PASS**

- [ ] **Step 6: Build the client**

`npm run build -w client` — a JSX error surfaces only here.

- [ ] **Step 7: Run the WHOLE suite**

- [ ] **Step 8: Checkpoint — DO NOT COMMIT**

Would stage: `client/src/components/RackPickerModal.jsx`, `server/src/plate-rack-state.test.js`
Message: `feat: take a plate off the rack from the picker`

---

### Task 7: The Set aside tab

**Files:**
- Modify: `client/src/components/PlatesLifecycle.jsx` — `rackRows` (line ~951), `SubTabs` (line ~1596), and the handler block beside `useFromRack` (~line 1019)
- Test: `server/src/plate-rack-state.test.js`

- [ ] **Step 1: Write the failing test**

Append:

```js
test('the warehouse has somewhere for a plate that is off the rack to live', () => {
  const page = read('client/src/components/PlatesLifecycle.jsx');
  // Without this tab a set-aside plate is invisible: Fresh and Used both filter
  // status === 'available', so nothing renders a plate in any other state and
  // there is nowhere to bring one back from.
  assert.match(page, /key:\s*'aside'/);
  assert.match(page, /PLATE_RESTORABLE_STATUSES|PLATE_SET_ASIDE_STATUSES|'awaiting_verification'/);
  assert.match(page, /make-available/);
  assert.match(page, /undo-movement/);
});

test('no plate is in two warehouse tabs, and none is in none', () => {
  const page = read('client/src/components/PlatesLifecycle.jsx');
  const start = page.indexOf('const rackRows');
  const body = page.slice(start, start + 900);
  assert.ok(body.length > 200, 'rackRows not found — the anchor moved');
  // Fresh and Used stay keyed on available; the third tab takes what they exclude.
  assert.match(body, /status === 'available'/);
});
```

- [ ] **Step 2: Run and confirm it FAILS**

- [ ] **Step 3: Add the row set and the tab**

Beside `rackRows` (~line 951):

```js
  // Everything that is off the rack but not in a job's hands. Fresh and Used are
  // both keyed on status === 'available', so without this list a set-aside plate
  // renders nowhere at all and can never be brought back.
  const ASIDE_STATUSES = ['damaged', 'lost', 'awaiting_verification', 'scrapped'];
  const asideRows = warehouse.filter(row => ASIDE_STATUSES.includes(row.status));
```

and make the view switch feed the table:

```js
  const rackRows = warehouseView === 'aside'
    ? asideRows
    : warehouse.filter(row => row.status === 'available'
      && (warehouseView === 'fresh' ? row.rack_location === FRESH_PLATES_RACK : row.rack_location === USED_PLATES_RACK));
```

Add the tab (~line 1596), beside Fresh and Used:

```jsx
          {key:'aside',label:'Set aside',count:asideRows.length},
```

- [ ] **Step 4: Add the handlers**

Beside `useFromRack` (~line 1019):

```js
  const setAsidePlate = async (assetId, reason) => {
    try {
      const out = await api.post('/plates/assets/set-aside', { asset_ids: [assetId], reason });
      // No Undo in the toast: ui.jsx's toast is push(type, msg) — message only,
      // no action slot — and it clears itself after 3800ms, which is too short to
      // offer one anyway. Undo lives on the Set aside tab row, where the plate
      // now is and where somebody would go looking for it.
      toast.success(`${out.plates.join(', ')} taken off the rack — undo it on the Set aside tab`);
    } catch (error) { toast.error(error.message); }
    finally { if (detail) await refreshDetail(); else await load(); }
  };
  const makeAvailable = async (assetId, condition, reason) => {
    try {
      const out = await api.post('/plates/assets/make-available',
        { asset_ids: [assetId], condition, reason });
      toast.success(`${out.plates.join(', ')} back on the rack as ${condition}`);
    } catch (error) { toast.error(error.message); }
    finally { await load(); }
  };
  const undoMovement = async movementId => {
    try {
      const out = await api.post('/plates/assets/undo-movement', { movement_id: movementId });
      toast.success(`${out.plate} put back — it is ${out.status.replace(/_/g, ' ')} again`);
    } catch (error) { toast.error(error.message); }
    finally { await load(); }
  };
```

**Already checked, do not re-litigate:** `ui.jsx:2066-2075` defines `push(type, msg)` and
`toast.success: m => push('success', m)`. It takes a message and nothing else, and clears after
3800ms. There is no action slot and adding one would mean rebuilding the toast stack, which is not
this feature's job. Undo is offered on the Set aside tab row only.

Pass `onSetAside={setAsidePlate}` to `<RackPickerModal …>`.

- [ ] **Step 5: Add the row actions on the Set aside tab**

The warehouse table's action column already renders per row. When `warehouseView === 'aside'`, each row offers:
- **Back on the rack** — opens a two-tap condition choice (`Good` / `Fair`), then calls `makeAvailable(row.id, condition, reason)`. Reason is a short free-text input; the button is disabled until it has content.
- **Undo** — shown only when the row's last movement was a set-aside; calls `undoMovement`.

Read how the existing action column is built (`{ key: 'actions', label: '', sortable: false` near line 1180) and follow it exactly.

- [ ] **Step 6: Run — expect 2 tests PASS**

- [ ] **Step 7: Build the client** — `npm run build -w client`

- [ ] **Step 8: Run the WHOLE suite**

- [ ] **Step 9: Checkpoint — DO NOT COMMIT**

Would stage: `client/src/components/PlatesLifecycle.jsx`, `server/src/plate-rack-state.test.js`
Message: `feat: a Set aside tab, and the way back from it`

---

### Task 8: Full gate and end-to-end verification

- [ ] **Step 1: Full gate** — `npm run verify`. Expected exit 0.

- [ ] **Step 2: No migration** — `git diff --stat 785474ee -- supabase/`. Expected empty. If not, stop: the plan assumed the existing CHECK constraints already permit every value.

- [ ] **Step 3: Verify against a local database — NOT production**

Do **not** exercise these endpoints against the live plant DB. Start a private Postgres on a port nobody else is using, from this worktree:

```
node_modules/@embedded-postgres/darwin-arm64/native/bin/pg_ctl -D server/.pgdata -o "-p 5451" -l /tmp/pg.log start
```

Create a database, then `DATABASE_URL=postgresql://postgres:postgres@localhost:5451/rackstate JWT_SECRET=verify PORT=4912 node src/index.js` from `server/` — it creates the schema and seeds itself. Mint a JWT with that secret rather than typing the generated admin password.

**Never `pkill -f "node src/index.js"`** — it matches other sessions' servers and kills the embedded Postgres they own. Stop yours by port: `kill $(lsof -tiTCP:4912 -sTCP:LISTEN)`.

Seed a plate, then confirm end to end:
- set aside with each reason → status changes, **condition does not**;
- the plate disappears from `GET /plates/requirements/:id/rack-candidates`;
- undo → back to `available`, at its original rack location;
- undo a second time → refused `MOVEMENT_SUPERSEDED`;
- retire, then make-available with `condition: 'Fair'` → `active=1`, rack `Used Plates Rack`;
- make-available with no condition → refused 400;
- set aside a `reserved` plate → refused 409 naming it.

- [ ] **Step 4: Verify the UI** — with the client on `VITE_API_TARGET=http://localhost:4912`, open a Plate PR, open the picker, take a plate off the rack, and confirm it leaves the list and appears on the Set aside tab. **Read `textContent`, not `innerText`** — the browser pane runs at 0×0 and `innerText` returns empty for laid-out-but-unrendered content.

- [ ] **Step 5: Report** — tests run and their result, what was verified against real data, and that nothing was committed, pushed or deployed.

---

## Self-review

**Spec coverage.** §1 state model → Tasks 1–2 (status-only, verified by test). §2 in-flight guard → Task 2. §3 un-retire → Tasks 3, 5, 7. §4 undo → Tasks 4, 5, 7. §5 placement → Tasks 6, 7. §6 endpoints → Task 5. §7 tests → each task. §8 delivery → Task 8.

**One deliberate narrowing against the spec.** §5 says the picker offers **Set aside and Retire**; Task 6 offers Set aside only. Retire is permanent, its reasons are a different list, and a modal whose job is choosing a plate is the wrong place to scrap one — the warehouse already offers Retire and keeps doing so. Flagged rather than silently dropped; say so if you want Retire in the picker too.

**Type consistency.** `validateSetAside` returns `{ picked, rule }`; Task 5 uses both. `validateMakeAvailable` returns the picked rows; Task 5 uses that. `invertMovement` returns `{ status, rack_location, active }` and deliberately **no** `condition`; Task 5's UPDATE sets exactly those three. `PLATE_SET_ASIDE_REASONS` rows are `{ key, label, status, action }` — no `condition` — used identically in Tasks 1, 2, 4 and 6. Route names match between Tasks 5 and 7 (`set-aside`, `make-available`, `undo-movement`).

**Resolved while reviewing, not left to the engineer.** The plan originally had Undo in the
success toast and told whoever executes it to check whether that was possible. `ui.jsx:2066-2075`
answers it: `push(type, msg)` takes a message only and auto-clears after 3800ms — no action slot,
and too brief to hold one. The toast-Undo is gone; §4 of the spec still holds, because it named
the Set aside tab row as the other place and that is now the only one. `USED_PLATES_RACK` is
confirmed already imported at `routes/plates.js:14`, so Task 5 needs no new import for it.
