# Plate Rack Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a planner choose which rack plate a Plate PR spends, swap it afterwards, and give it back to the rack — instead of `Use 4 from Rack` silently taking whichever four the ordering picked.

**Architecture:** Every decision moves into a pure function in `server/src/plates.js`; the route keeps only the SQL and the transaction. That is this repo's existing split (`pickAvailableRackPlates`, `validateReturnVerification` already live there) and it is also the only testable surface — **no test in this repo touches a database.** `bestPlateCandidate` is redefined as the head of a new `plateCandidates`, so the On Rack count, the picker's list and the plate the button takes all resolve through one query.

**Tech Stack:** Node ESM, Express, node:test, Postgres (`pg`), React 18, Tailwind. Workspaces: `server`, `client`.

**Worktree:** `/private/tmp/claude-501/-Users-anikdua-Documents-Projects-Colour-Imp-Production/407ec36d-f9aa-4d77-a9f3-54375e98be06/scratchpad/wt-rackpick`, branch `feat/plate-rack-picker` off `origin/main@e7102ef`. Do not touch `~/Documents/CI ERP FInal/ci-erp` — another session has uncommitted work in twelve files there.

**Spec:** `docs/superpowers/specs/2026-08-13-plate-rack-picker-design.md`

---

## Standing rule: no commits in this session

This directory's `CLAUDE.md` forbids `git commit`, `git push` and any deploy unless Anik sanctions it in the current session. He has not. **Every task therefore ends in a Checkpoint step, not a commit** — run the gate, confirm it is green, leave the work on disk. Each checkpoint names exactly what a commit would have staged, so the plan converts back to commits verbatim if he sanctions it later.

## Structured errors go under `body` — a guard enforces it

`app.js:80` writes `res.status(status).json({ error: err.message, ...(err.body || {}) })` — **`err.body` and nothing else**. A `code` hung directly on the error is dropped before the response is written, so the client sees only `error` and any page keying on that code is a dead button. `server/src/structured-errors.test.js` is a repo-wide source guard over six keys (`code`, `at`, `blockers`, `conflicts`, `existing`, `incoming`) that fails the build if you do it.

So: `{ status: 409, body: { code: 'X' } }`, never `{ status: 409, code: 'X' }`. Payload that only the calling code in this process reads — `refused`, `skipped` — may sit on the error directly; it is not on the guarded list and never needs to cross the wire.

**Do not work around the guard's regex** by assigning `err.code` after the object literal. That reproduces the shape the guard exists to prevent and puts the same value in two places. If a test wants the code, the test asserts `error.body.code`.

## Test idiom — read before writing any test

Two kinds of test exist here, and neither uses a database:

1. **Pure unit tests** — import a function from `plates.js` and assert on its return. Validators throw `Object.assign(new Error(msg), { status })`.
2. **Source-text tests** — `readFileSync` the route or component and `assert.match` a regex, to pin a law that has no runtime seam. `plate-lifecycle-wiring.test.js` is the model.

Client pure logic lives in `client/src/lib/` and is tested **from a server test file** that imports across the workspace (`server/src/board-math.test.js` does exactly this). A `.jsx` file cannot be imported by `node --test`, so nothing testable may live in the modal.

Gate for every task: `npm test -w server`. Never `node --test src/`.
Full gate before handover: `npm run verify`.

## File structure

| File | Responsibility | Change |
|---|---|---|
| `server/src/plates.js` | Pure plate logic, no I/O | **Modify** — add `nextPlateRequestStatus`, `resolveRackPicks`, `releasableRackComponents` |
| `server/src/plate-lifecycle.js` | DB-touching lifecycle helpers | **Modify** — add `plateCandidates`, redefine `bestPlateCandidate`, use `nextPlateRequestStatus` |
| `server/src/routes/plates.js` | HTTP + transactions | **Modify** — new `rack-candidates` and `release-rack` routes; `use-from-rack` learns picks |
| `client/src/lib/plateRack.js` | Pure client rack logic | **Modify** — add `defaultPickSelection`, `duplicatePickAssets`, `pickPayload` |
| `client/src/components/RackPickerModal.jsx` | The picker UI | **Create** |
| `client/src/components/PlatesLifecycle.jsx` | Plate PR list + form | **Modify** — 3 of 4 call sites open the picker; form gains Change/Undo |
| `server/src/plate-rack-reuse.test.js` | Rack reuse tests | **Modify** — all new tests land here |

---

### Task 1: One candidate query, two callers

**Files:**
- Modify: `server/src/plate-lifecycle.js:106-137`
- Test: `server/src/plate-rack-reuse.test.js`

- [ ] **Step 1: Write the failing test**

Append to `server/src/plate-rack-reuse.test.js`:

```js
// The load-bearing law of this feature. The On Rack count, the picker's list and
// the plate the button actually takes must come from ONE query — otherwise the
// picker will one day offer a plate the button refuses. bestPlateCandidate is
// therefore not allowed to carry its own SQL; it is the head of plateCandidates.
test('bestPlateCandidate is the first row of plateCandidates, not a second query', () => {
  const lifecycle = read('server/src/plate-lifecycle.js');
  const best = lifecycle.slice(lifecycle.indexOf('export async function bestPlateCandidate'));
  const body = best.slice(0, best.indexOf('\n}'));
  assert.match(body, /plateCandidates\(/);
  assert.doesNotMatch(body, /SELECT pa\.\*/);
  assert.doesNotMatch(body, /ORDER BY/);
  // Exactly one place spells the candidate ordering.
  assert.equal(lifecycle.split('CASE pa.condition').length - 1, 1);
});

test('plateCandidates keeps the condition-then-wear ordering and the safety filters', () => {
  const lifecycle = read('server/src/plate-lifecycle.js');
  const fn = lifecycle.slice(lifecycle.indexOf('export async function plateCandidates'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /CASE pa\.condition WHEN 'Good' THEN 0 ELSE 1 END/);
  assert.match(body, /pa\.use_count ASC/);
  assert.match(body, /pa\.last_used_at ASC NULLS FIRST/);
  assert.match(body, /pa\.status='available' AND pa\.active=1/);
  assert.match(body, /pa\.condition IN \('Good','Fair'\)/);
  assert.match(body, /AND NOT \$\{PLATE_ALREADY_CLAIMED_SQL\}/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- --test-name-pattern="plateCandidates"`
Expected: FAIL — `bestPlateCandidate` still contains `SELECT pa.*` and `plateCandidates` does not exist.

- [ ] **Step 3: Write minimal implementation**

Replace `server/src/plate-lifecycle.js:106-137` entirely with:

```js
// Every plate the rack can offer this component, best first.
//
// ONE spelling of the candidate set. bestPlateCandidate is its head, the picker
// lists it, and rackReusePlan counts against the same rules — so the column can
// never promise a plate the button refuses, nor the picker offer one it cannot
// take. Same law as plateArtworkMatchSql, one level up.
export async function plateCandidates(rows, request, component, plateMasterId, excludedAssetIds = [], limit = null) {
  const spec = request.specification || {};
  const version = artworkVersionOf(spec);
  const values = [request.product_id, plateArtworkKey(version), component.component_type,
    component.pantone_code || null, isBareArtworkRevision(version)];
  const masterSql = plateMasterId ? (values.push(plateMasterId), `AND pa.plate_master_id=$${values.length}`) : '';
  const excludedSql = excludedAssetIds.length
    ? (values.push(excludedAssetIds), `AND NOT (pa.id=ANY($${values.length}::int[]))`)
    : '';
  const limitSql = limit ? (values.push(limit), `LIMIT $${values.length}`) : '';
  return rows(`SELECT pa.*, pm.plate_size
    FROM plate_assets pa JOIN plate_masters pm ON pm.id=pa.plate_master_id
    WHERE pa.product_id=$1 AND ${plateArtworkMatchSql('pa.artwork_version', '$2', '$5')}
      AND pa.component_type=$3
      AND lower(COALESCE(pa.pantone_code,''))=lower(COALESCE($4,''))
      ${masterSql}
      ${excludedSql}
      AND pa.status='available' AND pa.active=1 AND pa.condition IN ('Good','Fair')
      AND NOT ${PLATE_ALREADY_CLAIMED_SQL}
    -- Condition first, wear second. A Good plate ALWAYS beats a Fair one, however
    -- many runs each has had: a worn-but-sound plate is a better bet on press than a
    -- fresh plate somebody has already graded down. Within a condition the least-worn
    -- plate is proposed; then the one idle longest, so the rack rotates instead of
    -- favouring one corner of it; id last, purely so the choice is deterministic.
    --
    -- This used to lead with verified_at DESC, which proposed whichever plate had
    -- most recently been LOOKED AT — unrelated to either condition or life left, and
    -- on a rack of identical plates it kept handing back the same one.
    ORDER BY CASE pa.condition WHEN 'Good' THEN 0 ELSE 1 END,
             pa.use_count ASC,
             pa.last_used_at ASC NULLS FIRST,
             pa.id ${limitSql}`, values);
}

// Takes a ROWS helper, not the one-row `oc` this used to be called with — see
// the call-site change in the next step.
export async function bestPlateCandidate(rows, request, component, plateMasterId, excludedAssetIds = []) {
  const [first] = await plateCandidates(rows, request, component, plateMasterId, excludedAssetIds, 1);
  return first || null;
}
```

**The first argument changes meaning, and both call sites must change with it.**
`db.js` confirms the shapes: at module level `q(text, params)` returns rows and `one(...)` returns one row or null; inside `tx(fn)` the bound pair is `qc` (rows) and `oc` (one row). `bestPlateCandidate` was called with `oc`, which returns a bare object — destructuring `const [first] = <object>` yields `undefined`, so leaving a call site on `oc` fails silently by proposing no plate at all rather than by throwing.

**`q()` inside `tx()` self-deadlocks on production.** The serverless pool runs `max: 1`, so a module-level `q` issued while a transaction holds the only client waits for itself for ever. Inside a transaction the helper passed here must always be that transaction's `qc`.

- [ ] **Step 4: Move both call sites from `oc` to `qc`**

There are exactly two, both already inside a transaction with `qc` in scope:

`server/src/plate-lifecycle.js:148`, inside `createPlateComponents(qc, oc, request, options)`:

```js
    const candidate = await bestPlateCandidate(qc, request, component, master?.id, proposedAssetIds);
```

`server/src/routes/plates.js:683`, inside `tx(async (qc, oc) => { ... })`:

```js
        const asset = await bestPlateCandidate(qc, request, component, component.plate_master_id, taken);
```

- [ ] **Step 5: Add the guard test for the deadlock**

Append to `server/src/plate-rack-reuse.test.js`:

```js
// Production's pool is max: 1, so a module-level q() issued while a transaction
// holds the only client waits for itself for ever. Every candidate read inside a
// transaction has to use that transaction's own rows helper.
test('candidate reads inside a transaction use the transaction client', () => {
  const lifecycle = read('server/src/plate-lifecycle.js');
  const route = read('server/src/routes/plates.js');
  assert.doesNotMatch(lifecycle, /bestPlateCandidate\(oc,/);
  assert.doesNotMatch(route, /bestPlateCandidate\(oc,/);
});
```

**A file-level ban on `plateCandidates(q,` would be wrong, so it is not written here.** Task 5's `GET /plates/requirements/:id/rack-candidates` runs outside any transaction and calls `plateCandidates(q, ...)` **correctly**; Task 6's `use-from-rack` runs inside `tx` and must call `plateCandidates(qc, ...)`. The same spelling is right in one file and wrong in another, so the guard has to be scoped to the route body that is inside a transaction — it lives in Task 6 Step 1, where it can actually be checked.

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -w server -- --test-name-pattern="plateCandidates|bestPlateCandidate|transaction client"`
Expected: PASS, 3 tests.

- [ ] **Step 7: Run the whole server suite — nothing may regress**

Run: `npm test -w server`
Expected: all pass. `plate-lifecycle.test.js` and `plates-never-block.test.js` both reference this function; if either fails, a call site still passes `oc`.

- [ ] **Step 8: Checkpoint (no commit — see standing rule)**

Would stage: `server/src/plate-lifecycle.js`, `server/src/routes/plates.js`, `server/src/plate-rack-reuse.test.js`
Message it would carry: `refactor: bestPlateCandidate becomes the head of plateCandidates`

---

### Task 2: Close the status hole undo will be the first to hit

**Files:**
- Modify: `server/src/plates.js` (add export near `plateReadinessSummary`, line 415)
- Modify: `server/src/plate-lifecycle.js:171-192`
- Test: `server/src/plate-rack-reuse.test.js`

- [ ] **Step 1: Write the failing test**

Append to `server/src/plate-rack-reuse.test.js`, and add `nextPlateRequestStatus` to the existing `import { ... } from './plates.js'` block at the top of the file:

```js
const summaryOf = (ready, required) => ({ is_ready: ready === required && required > 0, ready, required });

test('a request holding a reserved rack plate reads rack_reserved', () => {
  const next = nextPlateRequestStatus({
    current: 'pending',
    rows: [{ status: 'verified_existing' }, { status: 'pr_required' }],
    summary: summaryOf(1, 2),
  });
  assert.equal(next, 'rack_reserved');
});

// The hole undo is the first caller to reach. Release the LAST verified_existing
// line and no branch used to fire — not ready, nothing in procurement, no
// verified_existing left, and the status is 'rack_reserved' rather than 'ready'.
// The PR then said "Rack reserved" while holding no plate at all.
test('releasing the last rack plate drops the request out of rack_reserved', () => {
  const next = nextPlateRequestStatus({
    current: 'rack_reserved',
    rows: [{ status: 'pr_required' }, { status: 'pr_required' }],
    summary: summaryOf(0, 2),
  });
  assert.equal(next, 'pending');
});

test('procurement outranks a rack reservation, and readiness outranks both', () => {
  assert.equal(nextPlateRequestStatus({
    current: 'rack_reserved',
    rows: [{ status: 'verified_existing' }, { status: 'po_created' }],
    summary: summaryOf(1, 2),
  }), 'procurement');
  assert.equal(nextPlateRequestStatus({
    current: 'rack_reserved',
    rows: [{ status: 'verified_existing' }, { status: 'verified_existing' }],
    summary: summaryOf(2, 2),
  }), 'ready');
});

test('a status with nothing to say about it is left alone', () => {
  assert.equal(nextPlateRequestStatus({
    current: 'procurement',
    rows: [{ status: 'pr_required' }],
    summary: summaryOf(0, 1),
  }), 'procurement');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- --test-name-pattern="rack_reserved|procurement outranks|nothing to say"`
Expected: FAIL — `nextPlateRequestStatus is not a function`.

- [ ] **Step 3: Write the implementation**

Add to `server/src/plates.js`, immediately after `plateReadinessSummary`:

```js
// What a Plate PR's status should be, given its components. Pure, so the one
// branch that had never fired can be tested.
//
// The fallback used to read `else if (nextStatus === 'ready')`. Release the LAST
// verified_existing line of a rack_reserved request and nothing matched, so the
// request kept saying "Rack reserved" while holding no reserved plate. It never
// bit because the only two callers of releaseDraftPlateAssets are delete (which
// removes the request) and edit (whose next statement hard-sets 'pending').
// Undo is the first caller that empties the set and relies on this.
export function nextPlateRequestStatus({ current, rows = [], summary } = {}) {
  const PROCUREMENT = ['approved', 'po_created', 'ordered', 'grn_received'];
  if (summary?.is_ready) return 'ready';
  if (rows.some(row => PROCUREMENT.includes(row?.status))) return 'procurement';
  if (rows.some(row => row?.status === 'verified_existing')) return 'rack_reserved';
  if (['ready', 'rack_reserved'].includes(current)) return 'pending';
  return current;
}
```

Then in `server/src/plate-lifecycle.js`, add `nextPlateRequestStatus` to the import block from `./plates.js` (lines 1-14) and replace lines 176-180 of `syncPlateRequest` with:

```js
  const nextStatus = nextPlateRequestStatus({ current: current.status, rows, summary });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w server -- --test-name-pattern="rack_reserved|procurement outranks|nothing to say"`
Expected: PASS, 4 tests.

- [ ] **Step 5: Run the whole server suite**

Run: `npm test -w server`
Expected: all pass. `let nextStatus` became `const` — confirm nothing below line 180 reassigns it.

- [ ] **Step 6: Checkpoint (no commit)**

Would stage: `server/src/plates.js`, `server/src/plate-lifecycle.js`, `server/src/plate-rack-reuse.test.js`
Message: `fix: a Plate PR leaves rack_reserved when its last rack plate is released`

---

### Task 3: `resolveRackPicks` — the decision behind an explicit pick

**Files:**
- Modify: `server/src/plates.js` (add after `pickAvailableRackPlates`, line 500)
- Test: `server/src/plate-rack-reuse.test.js`

- [ ] **Step 1: Write the failing test**

Append to `server/src/plate-rack-reuse.test.js`, adding `resolveRackPicks` to the `./plates.js` import block:

```js
const pickComponent = (id, label, extra = {}) => ({
  id, component_label: label, status: extra.status || 'pr_required',
  matched_asset_id: extra.matched_asset_id || null,
});

test('an explicit pick assigns the plate the planner named', () => {
  const out = resolveRackPicks({
    components: [pickComponent(1, 'Cyan')],
    picks: [{ component_id: 1, asset_id: 903 }],
    candidates: { 1: [{ id: 901 }, { id: 903 }] },
  });
  assert.deepEqual(out.assignments, [
    { component_id: 1, asset_id: 903, swap: false, previous_asset_id: null },
  ]);
  assert.deepEqual(out.skipped, []);
  assert.deepEqual(out.consumed, [903]);
});

// A pick is a choice among what is offered. A plate id that never appeared in
// the candidate list is not a preference, it is a plate from another job.
test('a pick outside the candidate set is refused and nothing is assigned', () => {
  assert.throws(() => resolveRackPicks({
    components: [pickComponent(1, 'Cyan')],
    picks: [{ component_id: 1, asset_id: 555 }],
    candidates: { 1: [{ id: 901 }, { id: 903 }] },
  }), error => error.status === 409 && /not on offer for Cyan/.test(error.message));
});

// Two Cyan lines list the same plates on purpose — the planner may want plate X
// on the second line. One physical plate still cannot fill both.
test('the same plate picked for two lines is taken once and the second is named', () => {
  const out = resolveRackPicks({
    components: [pickComponent(1, 'Cyan'), pickComponent(2, 'Cyan')],
    picks: [{ component_id: 1, asset_id: 903 }, { component_id: 2, asset_id: 903 }],
    candidates: { 1: [{ id: 903 }], 2: [{ id: 903 }] },
  });
  assert.equal(out.assignments.length, 1);
  assert.equal(out.assignments[0].component_id, 1);
  assert.deepEqual(out.skipped, [
    { component_id: 2, component_label: 'Cyan', asset_id: 903, reason: 'duplicate' },
  ]);
});

test('picking a different plate for a line that already holds one is a swap', () => {
  const out = resolveRackPicks({
    components: [pickComponent(1, 'Cyan', { status: 'verified_existing', matched_asset_id: 901 })],
    picks: [{ component_id: 1, asset_id: 903 }],
    candidates: { 1: [{ id: 901 }, { id: 903 }] },
  });
  assert.deepEqual(out.assignments, [
    { component_id: 1, asset_id: 903, swap: true, previous_asset_id: 901 },
  ]);
});

test('re-picking the plate a line already holds does nothing', () => {
  const out = resolveRackPicks({
    components: [pickComponent(1, 'Cyan', { status: 'verified_existing', matched_asset_id: 901 })],
    picks: [{ component_id: 1, asset_id: 901 }],
    candidates: { 1: [{ id: 901 }] },
  });
  assert.deepEqual(out.assignments, []);
  assert.deepEqual(out.skipped, []);
});

test('a pick naming a component that is not on this requirement is ignored', () => {
  const out = resolveRackPicks({
    components: [pickComponent(1, 'Cyan')],
    picks: [{ component_id: 99, asset_id: 903 }],
    candidates: { 1: [{ id: 903 }] },
  });
  assert.deepEqual(out.assignments, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- --test-name-pattern="explicit pick|outside the candidate|picked for two lines|is a swap|already holds|not on this requirement"`
Expected: FAIL — `resolveRackPicks is not a function`.

- [ ] **Step 3: Write the implementation**

Add to `server/src/plates.js` immediately after `pickAvailableRackPlates`:

```js
// Turn "the planner ticked these plates" into "assign these, skip those".
//
// The asset ids arrive from a browser, so every one is checked back against the
// candidate list the server itself produced. A pick is a choice among what was
// offered — never a plate id taken on trust.
export function resolveRackPicks({ components = [], picks = [], candidates = {} } = {}) {
  const byId = new Map((Array.isArray(components) ? components : []).map(row => [Number(row.id), row]));
  const consumed = new Set();
  const assignments = [];
  const skipped = [];
  for (const pick of Array.isArray(picks) ? picks : []) {
    const componentId = Number(pick?.component_id);
    const assetId = Number(pick?.asset_id);
    const component = byId.get(componentId);
    if (!component || !assetId) continue;
    const offered = (candidates[componentId] || []).map(row => Number(row.id));
    if (!offered.includes(assetId)) {
      throw Object.assign(
        new Error(`Plate ${assetId} is not on offer for ${component.component_label}`),
        { status: 409, body: { code: 'PLATE_NOT_OFFERED' } });
    }
    // Already holding exactly this plate: a confirm that changes nothing.
    if (Number(component.matched_asset_id) === assetId) continue;
    if (consumed.has(assetId)) {
      skipped.push({ component_id: componentId, component_label: component.component_label,
        asset_id: assetId, reason: 'duplicate' });
      continue;
    }
    consumed.add(assetId);
    assignments.push({
      component_id: componentId,
      asset_id: assetId,
      swap: Boolean(component.matched_asset_id),
      previous_asset_id: component.matched_asset_id || null,
    });
  }
  return { assignments, skipped, consumed: [...consumed] };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w server -- --test-name-pattern="explicit pick|outside the candidate|picked for two lines|is a swap|already holds|not on this requirement"`
Expected: PASS, 6 tests.

- [ ] **Step 5: Checkpoint (no commit)**

Would stage: `server/src/plates.js`, `server/src/plate-rack-reuse.test.js`
Message: `feat: resolveRackPicks validates an explicit rack pick against what was offered`

---

### Task 4: `releasableRackComponents` — the decision behind undo

**Files:**
- Modify: `server/src/plates.js` (add after `resolveRackPicks`)
- Test: `server/src/plate-rack-reuse.test.js`

- [ ] **Step 1: Write the failing test**

Append to `server/src/plate-rack-reuse.test.js`, adding `releasableRackComponents` to the `./plates.js` import block:

```js
const held = (id, label, assetId) => ({
  id, component_label: label, status: 'verified_existing', matched_asset_id: assetId,
});

test('undo releases every line holding a rack plate when no line is named', () => {
  const out = releasableRackComponents({
    components: [held(1, 'Cyan', 901), held(2, 'Magenta', 902), pickComponent(3, 'Yellow')],
  });
  assert.deepEqual(out.releasable.map(row => row.id), [1, 2]);
  assert.deepEqual(out.refused, [
    { component_id: 3, component_label: 'Yellow', reason: 'no_plate' },
  ]);
});

test('undo can be scoped to one line', () => {
  const out = releasableRackComponents({
    components: [held(1, 'Cyan', 901), held(2, 'Magenta', 902)],
    componentIds: [2],
  });
  assert.deepEqual(out.releasable.map(row => row.id), [2]);
  assert.deepEqual(out.refused, []);
});

// Undo reaches exactly as far as the rack. A plate on the press has physically
// gone; bringing it back is a return, and the return flow owns that.
test('a plate already issued to printing is refused BY NAME, not skipped in silence', () => {
  assert.throws(() => releasableRackComponents({
    components: [{ id: 1, component_label: 'Cyan', status: 'issued', matched_asset_id: 901 }],
  }), error => error.status === 409
    && error.body.code === 'NO_RACK_PLATE_HELD'
    && error.refused[0].component_label === 'Cyan'
    && error.refused[0].reason === 'issued');
});

test('undo on a requirement holding nothing refuses rather than reporting success', () => {
  assert.throws(() => releasableRackComponents({
    components: [pickComponent(1, 'Cyan')],
  }), error => error.status === 409 && error.body.code === 'NO_RACK_PLATE_HELD');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- --test-name-pattern="undo releases|undo can be scoped|issued to printing is refused|holding nothing refuses"`
Expected: FAIL — `releasableRackComponents is not a function`.

- [ ] **Step 3: Write the implementation**

Add to `server/src/plates.js` immediately after `resolveRackPicks`:

```js
// Which lines undo may hand back. A line qualifies only while its plate is still
// ON the rack: reserved against this request and not yet issued.
//
// Refusals are returned, never swallowed. releaseDraftPlateAssets `continue`s
// past a plate that has moved on, which is right for delete — the request is
// going anyway — and wrong for an explicit undo, where the planner has to be
// told which plate they did not get back.
export function releasableRackComponents({ components = [], componentIds = null } = {}) {
  const wanted = Array.isArray(componentIds) && componentIds.length
    ? new Set(componentIds.map(Number))
    : null;
  const scoped = (Array.isArray(components) ? components : [])
    .filter(row => !wanted || wanted.has(Number(row.id)));
  const releasable = scoped.filter(row => row.matched_asset_id && row.status === 'verified_existing');
  const keep = new Set(releasable.map(row => row.id));
  const refused = scoped.filter(row => !keep.has(row.id)).map(row => ({
    component_id: row.id,
    component_label: row.component_label,
    reason: row.matched_asset_id ? row.status : 'no_plate',
  }));
  if (!releasable.length) {
    throw Object.assign(new Error('No plate on this requirement is holding a rack plate'),
      { status: 409, refused, body: { code: 'NO_RACK_PLATE_HELD' } });
  }
  return { releasable, refused };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w server -- --test-name-pattern="undo releases|undo can be scoped|issued to printing is refused|holding nothing refuses"`
Expected: PASS, 4 tests.

- [ ] **Step 5: Checkpoint (no commit)**

Would stage: `server/src/plates.js`, `server/src/plate-rack-reuse.test.js`
Message: `feat: releasableRackComponents decides what undo may hand back`

---

### Task 5: `GET /plates/requirements/:id/rack-candidates`

**Files:**
- Modify: `server/src/routes/plates.js` (insert immediately before the `use-from-rack` route, currently line 662)
- Test: `server/src/plate-rack-reuse.test.js`

- [ ] **Step 1: Write the failing test**

Append to `server/src/plate-rack-reuse.test.js`:

```js
test('the candidates endpoint offers claimable lines and lines already holding a plate', () => {
  const route = read('server/src/routes/plates.js');
  const fn = route.slice(route.indexOf("r.get('/plates/requirements/:id/rack-candidates'"));
  const body = fn.slice(0, fn.indexOf("\nr.post('"));
  // Same gate as spending a plate.
  assert.match(fn.slice(0, 120), /rack-candidates', canVerify/);
  // Claimable lines, PLUS verified_existing so the form can offer Change.
  assert.match(body, /RACK_CLAIMABLE_COMPONENT_STATUSES/);
  assert.match(body, /verified_existing/);
  // One spelling of the candidate set — never a hand-rolled second query.
  assert.match(body, /plateCandidates\(/);
  assert.doesNotMatch(body, /SELECT pa\.\* FROM plate_assets/);
  // The plate a line already holds is listed first and flagged.
  assert.match(body, /current: /);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- --test-name-pattern="candidates endpoint offers"`
Expected: FAIL — `indexOf` returns -1 and the slice is empty, so the first `assert.match` fails.

- [ ] **Step 3: Write the implementation**

Insert into `server/src/routes/plates.js` immediately before the `use-from-rack` route. Add `plateCandidates` to the existing `from '../plate-lifecycle.js'` import block (line 16) and `releasableRackComponents, resolveRackPicks` to the `from '../plates.js'` block (line 13).

```js
// What the rack could give each line of this Plate PR, so the planner picks
// rather than accepts. Best first — the same order the button would have taken
// them in, because it is the same query.
//
// Candidates are NOT cross-filtered between lines: two Cyan lines list the same
// plates on purpose, because the planner may want a particular plate on the
// second. One plate filling two lines is caught at confirm time, against the
// database rather than against a list that may already be stale.
r.get('/plates/requirements/:id/rack-candidates', canVerify, async (req, res, next) => {
  try {
    const request = await one(`SELECT * FROM tooling_requests
      WHERE id=$1 AND family='plate'`, [req.params.id]);
    if (!request) return res.status(404).json({ error: 'Plate requirement not found' });
    const components = await q(`SELECT * FROM plate_request_components
      WHERE tooling_request_id=$1 ORDER BY sequence_no`, [request.id]);
    const offerable = components.filter(row =>
      RACK_CLAIMABLE_COMPONENT_STATUSES.includes(row.status) || row.status === 'verified_existing');
    const masterId = requestPlateMasterId(components);
    const lines = [];
    for (const component of offerable) {
      const rows = await plateCandidates(q, request, component, masterId);
      const heldId = Number(component.matched_asset_id) || null;
      // The plate the line already holds leads the list, flagged, so Change
      // opens on the truth rather than on a fresh proposal.
      const candidates = rows.map(row => ({
        id: row.id,
        asset_number: row.asset_number,
        rack_location: row.rack_location,
        condition: row.condition,
        use_count: row.use_count,
        last_used_at: row.last_used_at,
        age_days: row.plate_created_on
          ? Math.max(0, Math.round((Date.now() - new Date(row.plate_created_on)) / 86400000))
          : null,
        artwork_version: row.artwork_version,
        plate_size: row.plate_size,
        current: Number(row.id) === heldId,
      })).sort((a, b) => Number(b.current) - Number(a.current));
      lines.push({
        component_id: component.id,
        component_label: component.component_label,
        component_type: component.component_type,
        pantone_code: component.pantone_code || null,
        status: component.status,
        matched_asset_id: heldId,
        candidates,
      });
    }
    res.json({ request_id: request.id, lines });
  } catch (error) { next(error); }
});
```

**Helpers:** this is a GET with no transaction, so the module-level `q` (rows) and `one` (single row) are correct here — the same pair `GET /plates/warehouse` uses. This route must **not** be wrapped in `tx()`; nothing is written, and prod's `max: 1` pool makes an unnecessary transaction a deadlock risk for no benefit.

**A held plate will not appear in its own candidate list** — `plateCandidates` filters `pa.status='available'` and a reserved plate is not available, so `current: true` would never be set. Step 4 fixes that.

- [ ] **Step 4: Handle the held plate, which the candidate query excludes**

`plateCandidates` filters `pa.status='available'`, so a line's currently-reserved plate cannot appear in its own candidate list and `current: true` would never be set. Fetch it separately and prepend:

```js
      if (heldId && !candidates.some(row => row.id === heldId)) {
        const own = await one(`SELECT pa.*, pm.plate_size FROM plate_assets pa
          JOIN plate_masters pm ON pm.id=pa.plate_master_id WHERE pa.id=$1`, [heldId]);
        if (own) {
          candidates.unshift({
            id: own.id, asset_number: own.asset_number, rack_location: own.rack_location,
            condition: own.condition, use_count: own.use_count, last_used_at: own.last_used_at,
            age_days: own.plate_created_on
              ? Math.max(0, Math.round((Date.now() - new Date(own.plate_created_on)) / 86400000))
              : null,
            artwork_version: own.artwork_version, plate_size: own.plate_size, current: true,
          });
        }
      }
```

Place this immediately after `candidates` is built and before `lines.push`. Then extract the repeated shaping into a local `const shape = (row, current) => ({ ... })` used by both — do not leave the object literal duplicated.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -w server -- --test-name-pattern="candidates endpoint offers"`
Expected: PASS.

- [ ] **Step 6: Run the whole server suite**

Run: `npm test -w server`
Expected: all pass.

- [ ] **Step 7: Checkpoint (no commit)**

Would stage: `server/src/routes/plates.js`, `server/src/plate-rack-reuse.test.js`
Message: `feat: a Plate PR can list the rack plates it could spend`

---

### Task 6: `use-from-rack` learns explicit picks and swaps

**Files:**
- Modify: `server/src/routes/plates.js:662-720` (the `use-from-rack` route)
- Test: `server/src/plate-rack-reuse.test.js`

- [ ] **Step 1: Write the failing test**

Append to `server/src/plate-rack-reuse.test.js`:

```js
test('use-from-rack takes explicit picks but still works blind', () => {
  const route = read('server/src/routes/plates.js');
  const fn = route.slice(route.indexOf("r.post('/plates/requirements/:id/use-from-rack'"));
  const body = fn.slice(0, fn.indexOf("\nr.post('/plates/requirements/:id/approve'"));
  // Picks are resolved by the pure validator, never trusted raw.
  assert.match(body, /resolveRackPicks\(/);
  assert.match(body, /req\.body\.picks/);
  // A line with no pick still falls back to the default — this is what keeps the
  // bulk dock and every existing caller working unchanged.
  assert.match(body, /bestPlateCandidate\(/);
  // A swap releases the old plate before reserving the new one, in this same tx.
  assert.match(body, /previous_asset_id/);
  assert.match(body, /swapped/);
  // The response names what it could not take.
  assert.match(body, /skipped/);
});

test('a line already satisfied is only reopened by a pick naming a different plate', () => {
  const route = read('server/src/routes/plates.js');
  const fn = route.slice(route.indexOf("r.post('/plates/requirements/:id/use-from-rack'"));
  const body = fn.slice(0, fn.indexOf("\nr.post('/plates/requirements/:id/approve'"));
  // Blind callers must never re-pick a line that already holds a plate.
  assert.match(body, /RACK_CLAIMABLE_COMPONENT_STATUSES/);
  assert.match(body, /pickedComponentIds/);
});

// The deadlock guard, scoped to the route body that runs inside a transaction.
// Production's pool is max: 1, so a module-level q() issued while a transaction
// holds the only client waits for itself for ever. This cannot be a file-level
// rule: GET /rack-candidates is outside any transaction and calls
// plateCandidates(q, ...) correctly, in this same file.
test('use-from-rack reads candidates on the transaction client, never the pool', () => {
  const route = read('server/src/routes/plates.js');
  const fn = route.slice(route.indexOf("r.post('/plates/requirements/:id/use-from-rack'"));
  const body = fn.slice(0, fn.indexOf("\nr.post('/plates/requirements/:id/approve'"));
  // Non-vacuous: a slice anchored on a name silently passes against the wrong
  // function if the anchor moves, so prove we sliced something real first.
  assert.ok(body.length > 500, 'use-from-rack route body not found — the anchor moved');
  assert.match(body, /plateCandidates\(qc,/);
  assert.doesNotMatch(body, /plateCandidates\(q,/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- --test-name-pattern="explicit picks but still works blind|only reopened by a pick"`
Expected: FAIL — `resolveRackPicks(` is not in the route body.

- [ ] **Step 3: Write the implementation**

In `server/src/routes/plates.js`, inside the `use-from-rack` handler, replace the component fetch and the pick loop. Keep the surrounding transaction, `syncPlateRequest`, `addRequestEvent` and `audit` calls exactly as they are.

```js
    const wanted = [...new Set((req.body.component_ids || []).map(Number).filter(Boolean))];
    const picks = Array.isArray(req.body.picks) ? req.body.picks : [];
    const pickedComponentIds = new Set(picks.map(row => Number(row?.component_id)).filter(Boolean));
    const result = await tx(async (qc, oc) => {
      const request = await oc(`SELECT * FROM tooling_requests
        WHERE id=$1 AND family='plate' FOR UPDATE`, [req.params.id]);
      if (!request) throw Object.assign(new Error('Plate requirement not found'), { status: 404 });
      const all = await qc(`SELECT * FROM plate_request_components
        WHERE tooling_request_id=$1 ORDER BY sequence_no FOR UPDATE`, [request.id]);
      // A satisfied line is reopened ONLY by a pick that names a different plate.
      // Without that second clause the bulk dock would re-pick lines that are
      // already done every time it ran.
      const eligible = all.filter(row => {
        if (wanted.length && !wanted.includes(row.id) && !pickedComponentIds.has(row.id)) return false;
        if (RACK_CLAIMABLE_COMPONENT_STATUSES.includes(row.status)) return true;
        if (row.status !== 'verified_existing') return false;
        const pick = picks.find(entry => Number(entry?.component_id) === row.id);
        return Boolean(pick) && Number(pick.asset_id) !== Number(row.matched_asset_id);
      });
      if (!eligible.length) {
        throw Object.assign(new Error('No plate on this requirement is waiting for a rack plate'), { status: 409 });
      }
      // Validate every pick against the candidate list the SERVER produces, using
      // the COMPONENT's own master — the same value the fallback below passes to
      // bestPlateCandidate, and the same one GET /rack-candidates lists by. A
      // request-level master would validate against a narrower set than the button
      // spends and reject a pick the picker legitimately offered.
      const candidates = {};
      for (const component of eligible.filter(row => pickedComponentIds.has(row.id))) {
        candidates[component.id] = await plateCandidates(qc, request, component, component.plate_master_id);
      }
      const { assignments, skipped } = resolveRackPicks({ components: eligible, picks, candidates });
      const byComponent = new Map(assignments.map(row => [row.component_id, row]));

      const taken = assignments.map(row => row.asset_id);
      const claimed = [];
      let swapped = 0;
      for (const component of eligible) {
        const assigned = byComponent.get(component.id);
        // A swap gives the old plate back first, in this same transaction, so a
        // line can never be seen holding two plates or none.
        if (assigned?.swap) {
          await releaseDraftPlateAssets(qc, request, [component], req.user.name,
            `Swapped out on ${request.request_number}`);
          swapped += 1;
        }
        const asset = assigned
          ? await oc('SELECT pa.*, pm.plate_size FROM plate_assets pa JOIN plate_masters pm ON pm.id=pa.plate_master_id WHERE pa.id=$1', [assigned.asset_id])
          : await bestPlateCandidate(oc, request, component, component.plate_master_id, taken);
        // A colour the rack cannot cover is SKIPPED, never fatal: three of four is
        // three plates the plant no longer has to buy, and the fourth stays on the
        // PR exactly as it was, still approvable onto a PO.
        if (!asset) continue;
        if (!assigned) taken.push(asset.id);
        claimed.push(component);
        await qc(`UPDATE plate_assets SET status='reserved',current_job_card_id=$1,
          verified_by=$2,verified_at=now(),updated_at=now() WHERE id=$3`,
        [request.job_card_id, req.user.name, asset.id]);
        await qc(`UPDATE plate_request_components SET status='verified_existing',
          proposed_asset_id=$1,matched_asset_id=$1,
          verified_found=1,verified_condition_ok=1,verified_artwork_ok=1,verified_colour_ok=1,verified_size_ok=1,
          verified_by=$2,verified_at=now(),updated_at=now() WHERE id=$3`,
        [asset.id, req.user.name, component.id]);
        await qc(`INSERT INTO plate_asset_movements
          (plate_asset_id,request_component_id,tooling_request_id,job_card_id,action,from_status,to_status,
           from_location,to_location,condition,note,user_name)
          VALUES ($1,$2,$3,$4,'reserved','available','reserved',$5,$5,$6,$7,$8)`,
        [asset.id, component.id, request.id, request.job_card_id, asset.rack_location, asset.condition,
         `Reused from rack for ${request.request_number}`, req.user.name]);
      }
      if (!claimed.length) {
        throw Object.assign(new Error('No matching plate is free on the rack any more'), { status: 409 });
      }
      const breakdown = plateBreakdownText(claimed);
      await syncPlateRequest(qc, oc, request.id, req.user.name);
      await addRequestEvent(qc, request.id, 'rack_reuse', request.status, 'rack_reserved',
        `${claimed.length} plate${claimed.length === 1 ? '' : 's'} taken from the rack · ${breakdown}`,
        req.user.name, 'warehouse');
      await audit('tooling_requirement', request.id, 'use_from_rack',
        `${claimed.length} of ${eligible.length} · ${breakdown}`, qc, req.user.name);
      return {
        request_id: request.id,
        reused: claimed.length - swapped,
        swapped,
        short: eligible.length - claimed.length,
        skipped,
      };
    });
```

**Watch:** `releaseDraftPlateAssets` is declared at line 97 of this file, above the route — no import needed. The `oc` fetch of a picked asset re-reads it inside the transaction; the row was already validated as offered, and the `FOR UPDATE` on components plus the `status='available'` filter in `plateCandidates` is what makes the pick still safe. If a picked plate has been taken between listing and confirming, `plateCandidates` will not have returned it and `resolveRackPicks` throws — which is the "rejected, nothing reserved" behaviour the spec asks for.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w server -- --test-name-pattern="explicit picks but still works blind|only reopened by a pick"`
Expected: PASS, 2 tests.

- [ ] **Step 5: Run the whole server suite**

Run: `npm test -w server`
Expected: all pass. `plate-rack-reuse.test.js` and `plate-partial-availability.test.js` both assert on this route's text; if either fails, read the assertion before changing it — it is probably pinning a law worth keeping.

- [ ] **Step 6: Checkpoint (no commit)**

Would stage: `server/src/routes/plates.js`, `server/src/plate-rack-reuse.test.js`
Message: `feat: a Plate PR can be told which rack plate to spend, and can swap it`

---

### Task 7: `release-rack` — undo

**Files:**
- Modify: `server/src/routes/plates.js:97-111` (`releaseDraftPlateAssets` returns its outcome)
- Modify: `server/src/routes/plates.js` (new route after `use-from-rack`)
- Test: `server/src/plate-rack-reuse.test.js`

- [ ] **Step 1: Write the failing test**

Append to `server/src/plate-rack-reuse.test.js`:

```js
test('releaseDraftPlateAssets reports what it could not release', () => {
  const route = read('server/src/routes/plates.js');
  const fn = route.slice(route.indexOf('async function releaseDraftPlateAssets'));
  const body = fn.slice(0, fn.indexOf('\nasync function deletePlateRequirements'));
  // Delete may ignore a plate that moved on; an explicit undo may not.
  assert.match(body, /released/);
  assert.match(body, /skipped/);
  assert.match(body, /return \{ released, skipped \}/);
});

test('undo returns the plate, resets the line, and refuses by name', () => {
  const route = read('server/src/routes/plates.js');
  const fn = route.slice(route.indexOf("r.post('/plates/requirements/:id/release-rack'"));
  const body = fn.slice(0, fn.indexOf('\nr.post(', 10));
  assert.match(fn.slice(0, 120), /release-rack', canVerify/);
  assert.match(body, /releasableRackComponents\(/);
  assert.match(body, /releaseDraftPlateAssets\(/);
  // The line goes back to needing a plate — and to being approvable onto a PO.
  assert.match(body, /status='pr_required'/);
  assert.match(body, /matched_asset_id=NULL/);
  assert.match(body, /proposed_asset_id=NULL/);
  assert.match(body, /verified_found=NULL/);
  // A structured code no page handles is a dead button; this one must be sent.
  assert.match(body, /RACK_PLATE_GONE/);
  assert.match(body, /syncPlateRequest\(/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- --test-name-pattern="could not release|undo returns the plate"`
Expected: FAIL — neither the return value nor the route exists.

- [ ] **Step 3: Make `releaseDraftPlateAssets` report**

Replace `server/src/routes/plates.js:97-111`:

```js
// Give reserved plates back to the rack.
//
// Returns what it did. Delete may ignore a plate that has moved on — the request
// is going anyway — but an explicit undo has to tell the planner which plate it
// did not get back, so the outcome is reported rather than swallowed. Existing
// callers ignore the return.
async function releaseDraftPlateAssets(qc, request, components, userName, note) {
  const reserved = components.filter(row => row.matched_asset_id);
  const released = [];
  const skipped = [];
  for (const component of reserved) {
    const [asset] = await qc(`UPDATE plate_assets SET status='available',current_job_card_id=NULL,updated_at=now()
      WHERE id=$1 AND status='reserved' AND current_job_card_id=$2 RETURNING *`,
    [component.matched_asset_id, request.job_card_id]);
    if (!asset) {
      const [gone] = await qc('SELECT asset_number,status FROM plate_assets WHERE id=$1',
        [component.matched_asset_id]);
      skipped.push({
        component_id: component.id,
        component_label: component.component_label,
        asset_number: gone?.asset_number || null,
        status: gone?.status || 'unknown',
      });
      continue;
    }
    released.push({ component_id: component.id, asset_id: asset.id, asset_number: asset.asset_number });
    await qc(`INSERT INTO plate_asset_movements
      (plate_asset_id,request_component_id,tooling_request_id,job_card_id,action,
       from_status,to_status,from_location,to_location,condition,note,user_name)
      VALUES ($1,$2,$3,$4,'adjustment','reserved','available',$5,$5,$6,$7,$8)`,
    [asset.id, component.id, request.id, request.job_card_id, asset.rack_location,
     asset.condition, note, userName]);
  }
  return { released, skipped };
}
```

- [ ] **Step 4: Write the route**

Insert into `server/src/routes/plates.js` immediately after the `use-from-rack` route:

```js
// Give a rack plate back. The exact inverse of the click that spent it.
//
// Undo reaches exactly as far as the rack: a plate still reserved here can go
// back on the shelf, a plate already issued to printing has physically gone and
// coming back is a RETURN, which the verification flow owns. Either way the
// planner is told which plate, by number.
r.post('/plates/requirements/:id/release-rack', canVerify, async (req, res, next) => {
  try {
    const wanted = [...new Set((req.body.component_ids || []).map(Number).filter(Boolean))];
    const result = await tx(async (qc, oc) => {
      const request = await oc(`SELECT * FROM tooling_requests
        WHERE id=$1 AND family='plate' FOR UPDATE`, [req.params.id]);
      if (!request) throw Object.assign(new Error('Plate requirement not found'), { status: 404 });
      const all = await qc(`SELECT * FROM plate_request_components
        WHERE tooling_request_id=$1 ORDER BY sequence_no FOR UPDATE`, [request.id]);
      const { releasable } = releasableRackComponents({
        components: all, componentIds: wanted.length ? wanted : null,
      });
      const { released, skipped } = await releaseDraftPlateAssets(qc, request, releasable,
        req.user.name, `Released from ${request.request_number}`);
      if (!released.length) {
        const first = skipped[0];
        // The code goes under `body` and ONLY there — see the note below.
        throw Object.assign(
          new Error(`${first?.asset_number || 'That plate'} is no longer on the rack — it is ${String(first?.status || 'unavailable').replace(/_/g, ' ')}`),
          { status: 409, skipped, body: { code: 'RACK_PLATE_GONE' } });
      }
      const freed = new Set(released.map(row => row.component_id));
      // Back to needing a plate — and to being approvable onto a PO, which is
      // exactly what refusing the rack's offer means.
      await qc(`UPDATE plate_request_components SET status='pr_required',
        matched_asset_id=NULL,proposed_asset_id=NULL,
        verified_found=NULL,verified_condition_ok=NULL,verified_artwork_ok=NULL,
        verified_colour_ok=NULL,verified_size_ok=NULL,
        verified_by=NULL,verified_at=NULL,updated_at=now()
        WHERE id=ANY($1::int[])`, [[...freed]]);
      const fresh = await qc('SELECT * FROM plate_request_components WHERE tooling_request_id=$1 ORDER BY sequence_no', [request.id]);
      await syncPlateRequest(qc, oc, request.id, req.user.name);
      await addRequestEvent(qc, request.id, 'rack_release', request.status, null,
        `${released.length} plate${released.length === 1 ? '' : 's'} returned to the rack · ${released.map(row => row.asset_number).join(', ')}`,
        req.user.name, 'warehouse');
      await audit('tooling_requirement', request.id, 'release_rack',
        `${released.length} released${skipped.length ? `, ${skipped.length} refused` : ''}`, qc, req.user.name);
      return { request_id: request.id, released: released.length, skipped, plates: fresh.length };
    });
    res.json(result);
  } catch (error) { next(error); }
});
```

**Watch:** `syncPlateRequest` re-reads components itself, so the `fresh` read above exists only to report the plate count — drop it if the response does not need it. Confirm `addRequestEvent`'s `to_status` accepts `null` (its INSERT passes `toStatus || null`, so it does).

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -w server -- --test-name-pattern="could not release|undo returns the plate"`
Expected: PASS, 2 tests.

- [ ] **Step 6: Run the whole server suite**

Run: `npm test -w server`
Expected: all pass.

- [ ] **Step 7: Checkpoint (no commit)**

Would stage: `server/src/routes/plates.js`, `server/src/plate-rack-reuse.test.js`
Message: `feat: a rack plate can be given back to the rack`

---

### Task 8: Client pure logic

**Files:**
- Modify: `client/src/lib/plateRack.js`
- Test: `server/src/plate-rack-reuse.test.js`

- [ ] **Step 1: Write the failing test**

Append to `server/src/plate-rack-reuse.test.js`. Add this import at the top of the file, beside the existing ones — a server test importing client lib is the established pattern here (`server/src/board-math.test.js` does the same):

```js
import { defaultPickSelection, duplicatePickAssets, pickPayload } from '../../client/src/lib/plateRack.js';
```

```js
test('the picker opens on the plate the line already holds, else the best candidate', () => {
  const selection = defaultPickSelection([
    { component_id: 1, candidates: [{ id: 901 }, { id: 903 }] },
    { component_id: 2, candidates: [{ id: 905 }, { id: 907, current: true }] },
    { component_id: 3, candidates: [] },
  ]);
  assert.deepEqual(selection, { 1: 901, 2: 907, 3: null });
});

test('picking one plate for two lines is caught before the request is sent', () => {
  assert.deepEqual(duplicatePickAssets({ 1: 903, 2: 903, 3: 905 }), [903]);
  assert.deepEqual(duplicatePickAssets({ 1: 903, 2: 905 }), []);
  // An unticked line is not a duplicate, however many there are.
  assert.deepEqual(duplicatePickAssets({ 1: null, 2: null }), []);
});

test('unticked lines are left out of the payload entirely', () => {
  assert.deepEqual(pickPayload({ 1: 903, 2: null, 3: 905 }), [
    { component_id: 1, asset_id: 903 },
    { component_id: 3, asset_id: 905 },
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- --test-name-pattern="picker opens on the plate|caught before the request|unticked lines"`
Expected: FAIL — the three functions are not exported.

- [ ] **Step 3: Write the implementation**

Append to `client/src/lib/plateRack.js`:

```js
// What the picker opens with: the plate the line already holds if it holds one,
// otherwise the best candidate — which is the plate the one-click button would
// have taken. Opening on anything else would make Confirm mean something
// different from the button it replaced.
export function defaultPickSelection(lines = []) {
  const out = {};
  for (const line of Array.isArray(lines) ? lines : []) {
    const candidates = line.candidates || [];
    out[line.component_id] = candidates.find(row => row.current)?.id ?? candidates[0]?.id ?? null;
  }
  return out;
}

// Two lines of the same colour list the same plates, so picking one plate twice
// is an easy slip. The server refuses it either way; catching it here means the
// planner is told before a round trip that half-succeeds.
export function duplicatePickAssets(selection = {}) {
  const seen = new Set();
  const duplicates = new Set();
  for (const assetId of Object.values(selection || {})) {
    if (!assetId) continue;
    if (seen.has(assetId)) duplicates.add(assetId);
    else seen.add(assetId);
  }
  return [...duplicates];
}

// An unticked line is a colour the planner has chosen to buy rather than reuse.
// It is left out of the payload, not sent as a null the server has to interpret.
export function pickPayload(selection = {}) {
  return Object.entries(selection || {})
    .filter(([, assetId]) => Boolean(assetId))
    .map(([componentId, assetId]) => ({ component_id: Number(componentId), asset_id: Number(assetId) }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w server -- --test-name-pattern="picker opens on the plate|caught before the request|unticked lines"`
Expected: PASS, 3 tests.

- [ ] **Step 5: Checkpoint (no commit)**

Would stage: `client/src/lib/plateRack.js`, `server/src/plate-rack-reuse.test.js`
Message: `feat: pure rack-picker selection logic`

---

### Task 9: `RackPickerModal`

**Files:**
- Create: `client/src/components/RackPickerModal.jsx`
- Test: `server/src/plate-rack-reuse.test.js` (source-text — a `.jsx` file cannot be imported by `node --test`)

- [ ] **Step 1: Write the failing test**

Append to `server/src/plate-rack-reuse.test.js`:

```js
test('the picker shows what distinguishes two identical-looking plates', () => {
  const modal = read('client/src/components/RackPickerModal.jsx');
  // Condition, wear and idle time are the whole reason to choose one over another.
  for (const field of ['asset_number', 'rack_location', 'condition', 'use_count', 'age_days']) {
    assert.match(modal, new RegExp(field));
  }
  // No arithmetic in the modal — selection logic lives in the tested lib.
  assert.match(modal, /from '\.\.\/lib\/plateRack\.js'/);
  assert.match(modal, /defaultPickSelection/);
  assert.match(modal, /duplicatePickAssets/);
  assert.match(modal, /pickPayload/);
  // A line may be left for the PO.
  assert.match(modal, /Buy this one/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- --test-name-pattern="picker shows what distinguishes"`
Expected: FAIL — `ENOENT`, the file does not exist.

- [ ] **Step 3: Read two existing modals before writing**

Run: `sed -n '1,60p' client/src/components/PlatesLifecycle.jsx` and find the `VerificationModal` definition, plus `grep -rn "export default function.*Modal" client/src/components/ | head`.

Match the existing modal shell, `Button` variants, and Tailwind classes exactly. Do not introduce a new modal primitive. This project's modals use `ci-form-panel-title` and the shared `Button` component; follow whatever the neighbours do.

- [ ] **Step 4: Write the modal**

Create `client/src/components/RackPickerModal.jsx`. Required behaviour, in the house style found in Step 3:

- Props: `{ open, requestNumber, lines, busy, onCancel, onConfirm }`.
- `useState` seeded from `defaultPickSelection(lines)`, re-seeded in a `useEffect` on `lines`.
- One block per line: `component_label`, then `{candidates.length} on rack`.
- Each candidate a radio row: `asset_number` · `rack_location` · `condition` · `{use_count} runs` · `{age_days}d`. The row with `current: true` carries a "currently on this line" chip.
- One extra radio per line labelled **Buy this one** (value `null`) — leaves the colour to the PO.
- `duplicatePickAssets(selection)` non-empty → show the clashing asset number inline and disable Confirm.
- Confirm label counts real ticks: `` `Reserve ${pickPayload(selection).length} plate(s)` ``; disabled at zero.
- `onConfirm(pickPayload(selection))`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -w server -- --test-name-pattern="picker shows what distinguishes"`
Expected: PASS.

- [ ] **Step 6: Build the client**

Run: `npm run build -w client`
Expected: build succeeds. A JSX syntax error surfaces only here — `node --test` never parses this file.

- [ ] **Step 7: Checkpoint (no commit)**

Would stage: `client/src/components/RackPickerModal.jsx`, `server/src/plate-rack-reuse.test.js`
Message: `feat: the rack picker modal`

---

### Task 10: Wire the picker, Change and Undo into the Plate PR page

**Files:**
- Modify: `client/src/components/PlatesLifecycle.jsx` — `useFromRack` (:1019), row button (:1139), form header (:1621), form line (:1636)
- Test: `server/src/plate-rack-reuse.test.js`

- [ ] **Step 1: Write the failing test**

Append to `server/src/plate-rack-reuse.test.js`:

```js
test('three of the four rack doors open the picker, and the bulk dock stays blind', () => {
  const page = read('client/src/components/PlatesLifecycle.jsx');
  assert.match(page, /RackPickerModal/);
  assert.match(page, /rack-candidates/);
  assert.match(page, /release-rack/);
  // Bulk across many PRs keeps taking defaults on purpose: picking plates for
  // twelve selected PRs is a lot of clicking for the case where the default is
  // right. It is the "I trust the ordering" door.
  const dock = page.slice(page.indexOf('const rackSelection'));
  assert.match(dock.slice(0, 4000), /useFromRack\(rackSelection\)/);
});

test('a structured refusal from undo is rendered, not swallowed', () => {
  const page = read('client/src/components/PlatesLifecycle.jsx');
  // A structured code no page handles is a dead button.
  assert.match(page, /RACK_PLATE_GONE|error\.message/);
  assert.match(page, /releaseRack/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- --test-name-pattern="three of the four rack doors|structured refusal from undo"`
Expected: FAIL — `RackPickerModal` is not referenced.

- [ ] **Step 3: Add the picker state and handlers**

In `client/src/components/PlatesLifecycle.jsx`, import the modal beside the other component imports, then add beside `useFromRack` (line 1019):

```js
  const [picker, setPicker] = useState(null);      // { row, lines, componentIds }
  const openPicker = async (row, componentIds = null) => {
    setBusyRow(row.id);
    try {
      const out = await api.get(`/plates/requirements/${row.id}/rack-candidates`);
      const lines = componentIds
        ? out.lines.filter(line => componentIds.includes(line.component_id))
        : out.lines;
      if (!lines.length) return toast.error('No plate on this requirement is waiting for a rack plate');
      setPicker({ row, lines });
    } catch (error) { toast.error(error.message); }
    finally { setBusyRow(null); }
  };
  const confirmPicks = async picks => {
    const row = picker.row;
    setPicker(null); setBusyRow(row.id);
    try {
      const out = await api.post(`/plates/requirements/${row.id}/use-from-rack`, { picks });
      const took = out.reused + out.swapped;
      if (took) toast.success(`${took} plate${took === 1 ? '' : 's'} taken from the rack — no need to buy ${took === 1 ? 'it' : 'them'}`);
      // Never silent: a plate the planner chose and did not get must be named.
      for (const miss of out.skipped || []) {
        toast.error(`${miss.component_label}: ${miss.asset_number || 'that plate'} was not taken (${miss.reason})`);
      }
    } catch (error) { toast.error(error.message); }
    finally { setBusyRow(null); if (detail) await refreshDetail(); else await load(); }
  };
  const releaseRack = async (row, componentIds = null) => {
    setBusyRow(row.id);
    try {
      const out = await api.post(`/plates/requirements/${row.id}/release-rack`,
        componentIds ? { component_ids: componentIds } : {});
      toast.success(`${out.released} plate${out.released === 1 ? '' : 's'} returned to the rack`);
      for (const miss of out.skipped || []) {
        toast.error(`${miss.component_label}: ${miss.asset_number || 'that plate'} is ${String(miss.status).replace(/_/g, ' ')}`);
      }
    } catch (error) { toast.error(error.message); }
    finally { setBusyRow(null); if (detail) await refreshDetail(); else await load(); }
  };
```

Leave `useFromRack` in place, unchanged — the bulk dock still calls it.

- [ ] **Step 4: Point the three doors at the picker**

Row button (line 1139) — change `onClick={() => useFromRack([row])}` to `onClick={() => openPicker(row)}`.

Form header (line 1621) — change `onClick={()=>useFromRack([detail])}` to `onClick={()=>openPicker(detail)}`.

Form line (line 1636) — change `onClick={()=>useFromRack([detail],rack.component_ids)}` to `onClick={()=>openPicker(detail, rack.component_ids)}`.

Then render the modal once, beside the other modals at the end of the component:

```jsx
      <RackPickerModal open={Boolean(picker)} requestNumber={picker?.row?.request_number}
        lines={picker?.lines || []} busy={busyRow === picker?.row?.id}
        onCancel={() => setPicker(null)} onConfirm={confirmPicks} />
```

- [ ] **Step 5: Add Change and Undo to a form line holding a plate**

At the form line (around line 1636), a line whose `lifecycle.status === 'verified_existing'` currently shows only its chip. Add its asset number and the two controls, beside the existing `Use` button and following its exact `Button` props:

```jsx
                {canVerify() && lifecycle?.status === 'verified_existing' && <>
                  <Button size="sm" variant="ghost" disabled={busyRow===detail.id}
                    onClick={()=>openPicker(detail,[lifecycle.id])}>Change</Button>
                  <Button size="sm" variant="ghost" disabled={busyRow===detail.id}
                    onClick={()=>releaseRack(detail,[lifecycle.id])}>Undo</Button>
                </>}
```

**Confirm first:** that `lifecycle` at this point is the component row and carries `id` and `status`. Read lines 1615-1645 before editing; if the variable holding the component is named otherwise, follow the file.

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -w server -- --test-name-pattern="three of the four rack doors|structured refusal from undo"`
Expected: PASS, 2 tests.

- [ ] **Step 7: Build the client**

Run: `npm run build -w client`
Expected: build succeeds.

- [ ] **Step 8: Checkpoint (no commit)**

Would stage: `client/src/components/PlatesLifecycle.jsx`, `server/src/plate-rack-reuse.test.js`
Message: `feat: choose, change and undo a rack plate from the Plate PR page`

---

### Task 11: Full gate and manual verification

- [ ] **Step 1: Run the full verify gate**

Run: `npm run verify`
Expected: baseline check passes, all server tests pass, client build succeeds.

- [ ] **Step 2: Confirm no schema change was needed**

Run: `git diff --stat origin/main -- supabase/`
Expected: empty. `reserved`, `verified_existing` and the movement action `reserved` all already exist on prod — verified when `main@8955843` shipped. If this diff is non-empty, stop: the plan assumed no migration.

- [ ] **Step 3: Verify against the live database, read-only**

Start the live-preview server per `ci-erp-verify-ui-without-a-password` (`live-db.env` carries no `JWT_SECRET`, so start it with your own and mint a token for that process). Open a Plate PR with `rack_reuse.total > 0` — `CI-TR-0105` in the screenshot had 4 of 4.

Confirm, reading the DOM rather than a screenshot (the browser pane serves stale frames):
- the green button opens the picker rather than reserving;
- each colour lists real asset numbers from the 1,358 plates loaded under `PLATE-WH-OPENING-2026-08-12`;
- picking a non-default plate reserves *that* asset number;
- **Undo** returns it and the On Rack count rises back;
- the PR leaves `rack_reserved` when the last plate is released — this is the Task 2 fix, and it is the one thing no unit test can prove end to end.

- [ ] **Step 4: Report**

Summarise: tests run and their result, what was verified against live data, and the standing rule that nothing was committed, pushed or deployed.

---

## Self-review

**Spec coverage.** §1 one query → Task 1. §2 candidates endpoint → Task 5. §3 picks and swap → Tasks 3, 6. §4 undo → Tasks 4, 7; the `syncPlateRequest` hole → Task 2. §5 client → Tasks 8, 9, 10, including the bulk dock staying blind (Task 10 Step 1) and the four call sites (Task 10 Step 4). §6 tests → each task's own steps. §7 delivery → Task 11.

**Spec tests that could not be written as specified.** The spec's test list assumed a database — "release returns the plate to `available`", "a pick reserved mid-flight is skipped". **No test in this repo touches a database**, so those became pure tests of the decision (Tasks 3, 4) plus source-text tests of the wiring (Tasks 5, 6, 7), with the true end-to-end behaviour verified by hand against the live DB in Task 11 Step 3. This is a real reduction in coverage against the spec and is called out rather than papered over.

**Type consistency.** `resolveRackPicks` returns `{ assignments, skipped, consumed }`; Task 6 uses `assignments` and `skipped` only. `releasableRackComponents` returns `{ releasable, refused }` and throws with `refused` attached; Task 7 uses `releasable`. `releaseDraftPlateAssets` returns `{ released, skipped }`; Task 7 uses both. `defaultPickSelection`/`duplicatePickAssets`/`pickPayload` are named identically in Tasks 8, 9 and 10. `plateCandidates(oc, request, component, plateMasterId, excludedAssetIds, limit)` — Task 5 calls it with four arguments (limit omitted, correct), Task 6 with four.

**Resolved while reviewing, not left to the engineer.** The plan originally told whoever executes it to work out how a multi-row read is issued. `db.js` answers it: `q`/`one` at module level, `qc`/`oc` bound inside `tx`. That turned up a defect the plan would otherwise have shipped — `bestPlateCandidate` is called with `oc` at both of its call sites, and `const [first] = <bare object>` is `undefined`, so a plan that changed only the function body would have made every automatic rack proposal silently stop finding plates. Task 1 Step 4 changes both call sites; Step 5 pins them, and pins the related production trap that `q()` inside `tx()` self-deadlocks on a `max: 1` pool.
