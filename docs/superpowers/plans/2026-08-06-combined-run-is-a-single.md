# A Combined Run is a Single — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the set-type zones calling a same-product Combined Run a Gang — it classifies as
Single across Planning and Print Planning, with a teal `Combined` chip to isolate them and
symmetric refusals so no tag can be written that the run's own kind would mask.

**Architecture:** The classifier is currently hand-rolled in two places — `rowSetType` in
`SetType.jsx` and `cardSetType` in `PrintPlanning.jsx` — and both test `gang_run_id`, a column a
merge shares with a gang by design. Following the `boardState.js` precedent, the pure rules move
to `client/src/lib/setType.js` (no imports, so a node test can execute them), `SetType.jsx`
re-exports them so no call site changes, and the fact narrows from `gang_run_id` to
`run_kind === 'gang'`. `run_kind` is already on both payloads. The server mirror in `set-type.js`
gains the symmetric refusal. **No migration, no new column.**

**Tech Stack:** React 18 + Vite + Tailwind (client), Express + node:test + Postgres (server).
`npm test -w server` runs `node --test src/*.test.js`; there is no client test runner, which is
why pure client rules live in `client/src/lib/` and are tested from the server suite.

> **NO COMMITS IN THIS PLAN.** This directory's working agreement is plan → code → execute,
> nothing ships. The writing-plans skill's checklist calls for a commit after each task; that
> step is deliberately replaced with a suite run. Do not `git commit`, `git push`, or deploy.
> Work stays on disk.

---

### Task 0: Isolated worktree

`PrintPlanning.jsx` and `orders.js` — two of the six files here — are already modified in the
shared tree by another session on branch `shade-card-simplification`. Editing them there would
tangle two pieces of work, and `git checkout --` in a shared tree destroys the other session's
edits. This gets its own worktree off `origin/main`.

**Files:**
- Create: worktree at `~/.config/superpowers/worktrees/ci-erp/combined-is-single`

- [ ] **Step 1: Create the worktree from origin/main**

```bash
git -C ~/"Documents/CI ERP FInal/ci-erp" worktree add -b combined-is-single ~/.config/superpowers/worktrees/ci-erp/combined-is-single origin/main
```

Expected: `Preparing worktree (new branch 'combined-is-single')` then `HEAD is now at 603ae61`.

- [ ] **Step 2: Symlink node_modules so the suite can run**

A fresh worktree fails 16 tests for missing `node_modules` — symlink rather than reinstall.

```bash
cd ~/.config/superpowers/worktrees/ci-erp/combined-is-single && ln -s ~/"Documents/CI ERP FInal/ci-erp/node_modules" node_modules
```

- [ ] **Step 3: Establish the green baseline BEFORE changing anything**

```bash
cd ~/.config/superpowers/worktrees/ci-erp/combined-is-single && npm test -w server 2>&1 | tail -5
```

Expected: `# pass` count with `# fail 0`. **Write the pass count down** — every later task
compares against it. If it is not 0 failures, stop and report; do not start on a red baseline.

---

### Task 1: Extract the pure classifier (no behaviour change)

A pure move, proven inert by a test that asserts today's behaviour and must stay green across
Task 2's narrowing for the gang and no-run cases.

**Files:**
- Create: `client/src/lib/setType.js`
- Modify: `client/src/components/SetType.jsx`
- Test: `server/src/set-type-zone.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `server/src/set-type-zone.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rowSetType, holdReasonOf, cardSetType } from '../../client/src/lib/setType.js';

// The zone a job wears, on the two screens that triage by it.
//
// Planning triages ORDER LINES: the stored tag is the planner's intent, and
// facts outrank it. Print Planning triages JOB CARDS, which carry no tag at
// all and are classified purely by fact. Both must agree about what a RUN is,
// or one screen calls a job Single while the other calls it Gang — which is
// exactly what shipped, because both tested `gang_run_id`, a column a
// combined run shares with a gang by design.

const line = (over = {}) => ({ status: 'pending', set_type: 'single', ...over });

// ── a lone line: the tag is the whole answer ──────────────────────────
test('zone: an uncombined line wears its own tag', () => {
  for (const t of ['single', 'gang', 'new_output'])
    assert.equal(rowSetType(line({ set_type: t })), t);
});

test('zone: a line with no tag at all reads Single', () => {
  assert.equal(rowSetType({ status: 'pending' }), 'single');
});

// ── hold outranks everything, always ──────────────────────────────────
test('zone: one held member parks the whole row', () => {
  const r = { ...line(), _gang: [line({ set_type: 'single' }), line({ set_type: 'hold' })] };
  assert.equal(rowSetType(r), 'hold');
});

test('zone: the hold reason is whichever member carries one', () => {
  const r = { _gang: [line({ hold_reason: null }), line({ hold_reason: 'shade card pending' })] };
  assert.equal(holdReasonOf(r), 'shade card pending');
  assert.equal(holdReasonOf(line()), '');
});

// ── a real gang: the shared sheet outranks the tag ────────────────────
test('zone: a gang run is Gang whatever the tag says', () => {
  const r = { ...line({ set_type: 'single' }), gang_run_id: 7, run_kind: 'gang', _gang: [line(), line()] };
  assert.equal(rowSetType(r), 'gang');
});

// ── the press board: facts only, no stored tag ────────────────────────
test('zone: a card on a gang run is Gang; a plain card is Single', () => {
  assert.equal(cardSetType({ gang_run_id: 7, run_kind: 'gang' }), 'gang');
  assert.equal(cardSetType({ gang_run_id: null, run_kind: null }), 'single');
});

test('zone: a press hold IS the hold — never a second flag', () => {
  assert.equal(cardSetType({ printing_status: 'hold' }), 'hold');
  assert.equal(cardSetType({ printing_status: 'hold', gang_run_id: 7, run_kind: 'gang' }), 'hold');
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd ~/.config/superpowers/worktrees/ci-erp/combined-is-single && npm test -w server 2>&1 | grep -A3 "set-type-zone"
```

Expected: FAIL — `Cannot find module '.../client/src/lib/setType.js'`.

- [ ] **Step 3: Create the lib with today's rules unchanged**

Create `client/src/lib/setType.js`:

```js
// Set-type classification — the pure rules, written once.
//
// Two screens read them and neither may hand-roll a copy (the gang-anchor
// rule: a rule with one spelling can be fixed once; a rule with two gets fixed
// once and stays broken in the other). Planning triages ORDER LINES, where the
// stored tag is intent and facts outrank it. Print Planning triages JOB CARDS,
// which carry no tag at all and are classified purely by fact.
//
// This lives in lib/ rather than components/SetType.jsx because that file
// holds JSX and cannot be imported by a node test — so the rule that decides
// what the plant sees had never been executed by a test at all, only grepped.
// SetType.jsx re-exports everything here, so every import site is unchanged.

// The ONE fact that forces a zone: a gang shares its sheet with other products
// and splits after die cutting, so it can never print on its own terms.
export const isGangRun = r => r?.run_kind === 'gang';

// A COMBINED RUN (kind 'merge') deliberately forces nothing. One product, one
// plate, several sales orders — physically a Single, which is why it falls
// through to the line's own tag rather than being pinned to 'single': a
// combined run needing a fresh plate set is New Output, exactly as an
// uncombined one would be.
export const isMergeRun = r => r?.run_kind === 'merge';

// A Planning row — the collapsed run (members on `_gang`) or a lone line.
//   hold      any member on hold parks the whole row; a run moves as one
//   gang      the sheet is shared, so no tag may say otherwise
//   otherwise the planner's stored intent, defaulting to single
export const rowSetType = r => ((r._gang || [r]).some(m => m.set_type === 'hold') ? 'hold'
  : isGangRun(r) ? 'gang' : (r.set_type || 'single'));

export const holdReasonOf = r => (r._gang || [r]).map(m => m.hold_reason).find(Boolean) || '';

// A Print Planning card. No stored tag exists here, so the fall-through lands
// on 'single' directly. The press hold IS the hold — never a second flag.
export const cardSetType = c => (c.printing_status === 'hold' ? 'hold'
  : isGangRun(c) ? 'gang' : 'single');
```

**Note for Task 2:** `isGangRun` already reads `run_kind`, so this file is written in its final
shape. What still classifies a merge as a gang after this task is *Planning.jsx and
PrintPlanning.jsx not using it yet* — they still hold their own copies. Task 1 is inert because
nothing imports the lib but the test.

- [ ] **Step 4: Re-export from SetType.jsx so no call site changes**

In `client/src/components/SetType.jsx`, delete the two local definitions:

```js
export const rowSetType = r => ((r._gang || [r]).some(m => m.set_type === 'hold') ? 'hold'
  : r.gang_run_id ? 'gang' : (r.set_type || 'single'));
export const holdReasonOf = r => (r._gang || [r]).map(m => m.hold_reason).find(Boolean) || '';
```

and replace them with a re-export, placed directly below the `lucide-react` import:

```js
// The pure rules live in lib/setType.js so a node test can execute them —
// this file holds JSX and cannot be imported by one. Re-exported here so every
// existing `from '../components/SetType.jsx'` import keeps working unchanged.
export { rowSetType, holdReasonOf, cardSetType, isGangRun, isMergeRun } from '../lib/setType.js';
```

- [ ] **Step 5: Run the suite — the new test passes and nothing else moved**

```bash
cd ~/.config/superpowers/worktrees/ci-erp/combined-is-single && npm test -w server 2>&1 | tail -5
```

Expected: `# fail 0`, pass count = the Task 0 baseline **+ 7**.

- [ ] **Step 6: Confirm the client still builds**

```bash
cd ~/.config/superpowers/worktrees/ci-erp/combined-is-single && npm run build -w client 2>&1 | tail -5
```

Expected: `✓ built in …`. A broken import path fails here, not in the node suite.

---

### Task 2: Planning reads the lib — a merge stops being a gang

**Files:**
- Modify: `client/src/pages/Planning.jsx` (`setTypeMenuItems`, bulk `anyGanged`)
- Test: `server/src/set-type-zone.test.js`

- [ ] **Step 1: Write the failing test**

Append to `server/src/set-type-zone.test.js`:

```js
// ── a COMBINED RUN is a Single ────────────────────────────────────────
// The whole point: a merge reuses `gang_run_id` so every "which card is this
// line riding?" lateral keeps working, which left the zone classifier unable
// to tell the two apart. It filed a run that never splits under a chip whose
// entire meaning is "this splits after die cutting".
const mergeRow = (over = {}) => ({
  ...line(), gang_run_id: 7, run_kind: 'merge',
  _gang: [line(), line()], ...over,
});

test('zone: a combined run is Single, not Gang', () => {
  assert.equal(rowSetType(mergeRow()), 'single');
});

test('zone: a combined run needing plates is New Output — the tag is not overridden', () => {
  assert.equal(rowSetType(mergeRow({
    set_type: 'new_output', _gang: [line({ set_type: 'new_output' }), line({ set_type: 'new_output' })],
  })), 'new_output',
  'pinning a merge to "single" would make New Output unreachable on a combined run');
});

test('zone: hold still outranks the merge fact', () => {
  assert.equal(rowSetType(mergeRow({ _gang: [line(), line({ set_type: 'hold' })] })), 'hold',
    'this is what keeps the live Hold count at 10 rather than moving a held run to Single');
});

test('zone: a combined-run CARD is Single on the press board too', () => {
  assert.equal(cardSetType({ gang_run_id: 7, run_kind: 'merge' }), 'single',
    'Planning and the press board disagreeing about one run is the drift the shared lib prevents');
});

test('zone: the two run kinds are told apart by kind, never by gang_run_id', () => {
  assert.equal(rowSetType({ ...line(), gang_run_id: 7, run_kind: 'gang' }), 'gang');
  assert.equal(rowSetType({ ...line(), gang_run_id: 7, run_kind: 'merge' }), 'single');
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd ~/.config/superpowers/worktrees/ci-erp/combined-is-single && npm test -w server 2>&1 | grep -c "^not ok"
```

Expected: `0` — **these tests already pass**, because Task 1 wrote `isGangRun` in its final
shape. That is correct and expected: the lib is right, and what is still wrong is the two pages
holding their own copies. The remaining steps remove those copies. Record the pass count
(baseline + 12) and move on.

- [ ] **Step 3: Fix the row dropdown to offer what the server will accept**

In `client/src/pages/Planning.jsx`, replace the `opts` line inside `setTypeMenuItems`:

```js
    // A ganged row never offers Single — it physically shares a sheet.
    const opts = (row.gang_run_id ? ['gang', 'hold'] : ['single', 'gang', 'new_output', 'hold']).filter(k => k !== cur);
```

with:

```js
    // What the run's own KIND allows — the same rule set-type.js enforces, so
    // a planner never meets a refusal the menu could have prevented. A gang
    // shares a sheet, so it can never be Single or New Output. A combined run
    // is one product on one plate, so it can never be Gang: that tag would be
    // masked by its own kind the moment it was written.
    const opts = (row.run_kind === 'gang' ? ['gang', 'hold']
      : row.run_kind === 'merge' ? ['single', 'new_output', 'hold']
      : ['single', 'gang', 'new_output', 'hold']).filter(k => k !== cur);
```

- [ ] **Step 4: Fix the bulk bar's hide rule the same way**

> **Drift check, 2026-08-06.** `origin/main` moved 15 commits between writing this plan and
> executing it, and `0812e8b feat(planning): ask to gang at the rows, and split movement from
> workflow` restructured this exact block — the per-button `cls` strings are gone (the buttons now
> take their colour from `SET_TYPE_META[b.key].chip`) and `tagButtons` is now `chips`. The
> snippets below are the **post-`198edd3`** shape. Re-check before editing if main has moved
> again.

In the `extra={...}` block of `BulkWorkflowControls`, replace:

```js
          const anyGanged = selectedLines.some(l => l.gang_run_id);
          const BULK = [
            { key: 'single', solo: true },
            { key: 'gang' },
            { key: 'new_output', solo: true },
            { key: 'hold' },
          ];
```

with:

```js
          // Hidden by RUN KIND, matching the server's refusals in both
          // directions: Single and New Output cannot land on a gang (the sheet
          // is shared), and Gang cannot land on a combined run (one product,
          // one plate). Offering either would promise a move that 400s.
          const anyGang = selectedLines.some(isGangRun);
          const anyMerge = selectedLines.some(isMergeRun);
          const BULK = [
            { key: 'single', hideOn: 'gang' },
            { key: 'gang', hideOn: 'merge' },
            { key: 'new_output', hideOn: 'gang' },
            { key: 'hold' },
          ];
```

and replace the filter line:

```js
          const chips = BULK.filter(b => !(b.solo && anyGanged)).map(b => {
```

with:

```js
          const chips = BULK.filter(b =>
            !(b.hideOn === 'gang' && anyGang) && !(b.hideOn === 'merge' && anyMerge)).map(b => {
```

Also update the comment three lines above `anyGanged`, which still says only that Single and New
Output hide on a ganged job.

- [ ] **Step 5: Run the suite and build**

```bash
cd ~/.config/superpowers/worktrees/ci-erp/combined-is-single && npm test -w server 2>&1 | tail -3 && npm run build -w client 2>&1 | tail -3
```

Expected: `# fail 0` at baseline + 12; client build `✓ built in …`.

---

### Task 3: The server refuses the tag a run's kind would mask

**Files:**
- Modify: `server/src/set-type.js`
- Test: `server/src/set-type.test.js`

- [ ] **Step 1: Write the failing test**

In `server/src/set-type.test.js`, replace the existing `pending` helper (it cannot express a run
kind) with one that can, keeping the old two-arg calls working:

```js
const pending = (id, gang = null, run_kind = gang ? 'gang' : null) => ({ id, status: 'pending', gang_run_id: gang, run_kind });
const merged = (id, gang = 7) => ({ id, status: 'pending', gang_run_id: gang, run_kind: 'merge' });
```

Then append this section to the end of the file:

```js
// ── the combined-run rule ─────────────────────────────────────────────
// A merge reuses gang_run_id by design, so "is there a run?" cannot decide
// what may be tagged — only "what KIND of run?" can. The refusals are
// symmetric because the reason is: a tag the run's own kind would mask is a
// lie, not a preference.
test('set-type: a combined run CAN be tagged single — it is one product on one plate', () => {
  const line = merged(1);
  assert.equal(setTypeError({ line, members: [line, merged(2)], set_type: 'single', reason: '' }), null);
});

test('set-type: a combined run CAN be tagged new output — combining does not make plates appear', () => {
  const line = merged(1);
  assert.equal(setTypeError({ line, members: [line, merged(2)], set_type: 'new_output', reason: '' }), null);
});

test('set-type: a combined run can NEVER be tagged gang — its own kind would mask it', () => {
  const line = merged(1);
  assert.match(setTypeError({ line, members: [line, merged(2)], set_type: 'gang', reason: '' }),
    /combined run/);
});

test('set-type: hold still lands on a combined run, and still demands its reason', () => {
  const line = merged(1);
  assert.equal(setTypeError({ line, members: [line, merged(2)], set_type: 'hold', reason: 'shade card pending' }), null);
  assert.match(setTypeError({ line, members: [line, merged(2)], set_type: 'hold', reason: '  ' }), /why this job is on hold/);
});

test('set-type: a locked plan still refuses on a combined run', () => {
  const line = merged(1);
  assert.match(setTypeError({
    line, members: [line, { id: 2, status: 'planned', gang_run_id: 7, run_kind: 'merge' }],
    set_type: 'single', reason: '',
  }), /locked plan/);
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd ~/.config/superpowers/worktrees/ci-erp/combined-is-single && npm test -w server 2>&1 | grep -B1 -A6 "combined run"
```

Expected: FAIL on three of them — `single` and `new_output` currently return *"A ganged job
cannot print on its own"*, and `gang` currently returns `null` instead of a refusal.

- [ ] **Step 3: Narrow the refusals to the run's kind**

In `server/src/set-type.js`, replace:

```js
// The tags a line already sharing a sheet may NOT wear. Both describe a job
// printing on its own terms, so the gang fact would mask them the moment they
// were written — a stored value nothing can ever display is a lie, not a
// preference. Remove the line from the gang first.
const SOLO_ONLY = ['single', 'new_output'];
```

with:

```js
// A stored value nothing can ever display is a lie, not a preference — so each
// run kind refuses exactly the tags its own fact would mask.
//
// SOLO_ONLY  a GANG shares its sheet with other products and splits after die
//            cutting, so it can never print on its own terms.
// 'gang'     a COMBINED RUN is one product on one plate across several sales
//            orders. It is physically a Single and never splits, so the Gang
//            tag could never be shown even if it were written.
const SOLO_ONLY = ['single', 'new_output'];
```

and replace the refusal itself:

```js
  if (line.gang_run_id && SOLO_ONLY.includes(set_type))
    return 'A ganged job cannot print on its own — remove it from the gang first';
```

with:

```js
  if (line.run_kind === 'gang' && SOLO_ONLY.includes(set_type))
    return 'A ganged job cannot print on its own — remove it from the gang first';
  if (line.run_kind === 'merge' && set_type === 'gang')
    return 'A combined run is one product on one plate — split the combined run before ganging it';
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd ~/.config/superpowers/worktrees/ci-erp/combined-is-single && npm test -w server 2>&1 | tail -3
```

Expected: `# fail 0`, pass count = baseline + 17.

---

### Task 4: The route supplies the run kind

`setTypeError` now reads `line.run_kind`, which the route's `SELECT` does not fetch — without
this it is `undefined` and **every refusal silently stops firing**, including the gang ones that
work today.

**Files:**
- Modify: `server/src/routes/orders.js` (PATCH `/planning/:id/set-type`, ~line 1027)

- [ ] **Step 1: Join gang_runs for the kind**

Replace:

```js
    const line = await one('SELECT id, status, gang_run_id FROM order_lines WHERE id=$1', [+req.params.id]);
```

with:

```js
    // gr.kind decides which tags this line may wear (set-type.js) — a gang and
    // a combined run share gang_run_id, so the column alone cannot tell them
    // apart. LEFT JOIN: an uncombined line is the common case and must survive.
    const line = await one(`SELECT ol.id, ol.status, ol.gang_run_id, gr.kind AS run_kind
      FROM order_lines ol LEFT JOIN gang_runs gr ON gr.id = ol.gang_run_id
      WHERE ol.id=$1`, [+req.params.id]);
```

- [ ] **Step 2: Verify no other refusal read gang_run_id**

```bash
cd ~/.config/superpowers/worktrees/ci-erp/combined-is-single && grep -n "gang_run_id" server/src/set-type.js
```

Expected: **no output.** Every decision in that file now turns on `run_kind`. Any surviving hit
is a refusal still using the ambiguous column and must be converted.

- [ ] **Step 3: Run the suite**

```bash
cd ~/.config/superpowers/worktrees/ci-erp/combined-is-single && npm test -w server 2>&1 | tail -3
```

Expected: `# fail 0` at baseline + 17.

---

### Task 5: The Combined chip on Planning

Second axis, not a sixth zone — it narrows whichever zone is open and is hidden at zero, so the
strip does not grow on a day with no combined runs in view.

**Files:**
- Modify: `client/src/pages/Planning.jsx` (state ~line 452, counts ~line 586, chip strip ~line 2375)

- [ ] **Step 1: Add the filter state beside `draftOnly`**

After the `const [draftOnly, setDraftOnly] = useState(false);` line and its comment, add:

```js
  // "Combined" — the same kind of second axis as Plan saved, and for the same
  // reason: a combined run IS a Single (one product, one plate, several sales
  // orders), so it must not become a sixth zone that pulls it back out of the
  // Single chip. It is a pure FACT (`run_kind`), orthogonal to the zone, so it
  // composes with Plan saved instead of competing with it.
  const [mergeOnly, setMergeOnly] = useState(false);
```

- [ ] **Step 2: Count and filter alongside the draft axis**

Replace:

```js
  const draftCount = zoneRows.filter(rowDraft).length;
```
...
```js
  const groupedRows = draftOnly && draftCount ? zoneRows.filter(rowDraft) : zoneRows;
```

with:

```js
  const draftCount = zoneRows.filter(rowDraft).length;
  // Counted on the ZONE like draftCount, so each chip says how many of the rows
  // in front of the planner it would keep — never how many the other chip left.
  const mergeCount = zoneRows.filter(isMergeRun).length;
```
...
```js
  // Both axes compose, and each is guarded by its own count so a filter left on
  // cannot outlive the rows it filtered: when the last one in view is gone the
  // chip disappears and the queue comes back, instead of stranding the planner
  // on an empty table with no visible control to clear.
  const groupedRows = (() => {
    let rows = zoneRows;
    if (mergeOnly && mergeCount) rows = rows.filter(isMergeRun);
    if (draftOnly && draftCount) rows = rows.filter(rowDraft);
    return rows;
  })();
```

`isMergeRun` comes from the shared lib — add it to the existing `SetType.jsx` import at the top
of the file rather than writing `r.run_kind === 'merge'` inline. A locally re-spelled predicate
is the same drift this whole change exists to remove.

- [ ] **Step 3: Render the chip — one divider for both axes**

Replace the whole `{draftCount > 0 && <>...</>}` block at the end of the zone strip with:

```js
        {/* The second AXIS — chips that narrow whichever zone is open rather
            than partitioning the tab the way the set-types do. One hairline
            divider serves both, so adding Combined costs no separator; each
            hides at zero, so on a day with neither the strip is exactly as
            wide as it was before either existed. */}
        {(mergeCount > 0 || draftCount > 0)
          && <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-[#1D1D1F]/[0.10]" />}
        {mergeCount > 0 && (
          <button type="button" onClick={() => { setMergeOnly(v => !v); clearSelection(); }}
            title="Combined runs only — one product on several sales orders, printed as one pile"
            aria-pressed={mergeOnly}
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold transition-colors ${
              mergeOnly
                ? 'bg-teal-100 text-teal-800 ring-1 ring-teal-200'
                : 'bg-[#1D1D1F]/[0.05] text-[#6E6E73] hover:bg-[#1D1D1F]/[0.09] hover:text-[#1D1D1F]'}`}>
            <Layers size={11} /> Combined
            <span className={`rounded-full px-1.5 text-[10px] ${mergeOnly ? 'bg-white/25' : 'bg-[#1D1D1F]/[0.07]'}`}>
              {fmt.num(mergeCount)}
            </span>
          </button>
        )}
        {draftCount > 0 && (
          <button type="button" onClick={() => { setDraftOnly(v => !v); clearSelection(); }}
            title="Show only jobs whose plan is saved and still waiting to be locked"
            aria-pressed={draftOnly}
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold transition-colors ${
              draftOnly
                ? 'bg-blue-100 text-blue-800 ring-1 ring-blue-200'
                : 'bg-[#1D1D1F]/[0.05] text-[#6E6E73] hover:bg-[#1D1D1F]/[0.09] hover:text-[#1D1D1F]'}`}>
            <BookmarkCheck size={11} /> Plan saved
            <span className={`rounded-full px-1.5 text-[10px] ${draftOnly ? 'bg-white/25' : 'bg-[#1D1D1F]/[0.07]'}`}>
              {fmt.num(draftCount)}
            </span>
          </button>
        )}
```

Teal because across this ERP violet means *"splits after die cutting"* — the one thing a merge
never does. `Layers` is the icon on the **Combine Orders** button that creates these runs, and is
already imported in this file.

- [ ] **Step 4: Build and confirm no unused-import or scope errors**

```bash
cd ~/.config/superpowers/worktrees/ci-erp/combined-is-single && npm run build -w client 2>&1 | tail -5
```

Expected: `✓ built in …`.

---

### Task 6: Print Planning — same classifier, same chip

**Files:**
- Modify: `client/src/pages/PrintPlanning.jsx` (line 12 imports, line 32 `cardSetType`, ~line 641 `zoneOf`, ~line 661 `zoneCounts`, ~line 1353 chip strip)

- [ ] **Step 1: Import the shared classifier and the icon**

Delete the local definition at line 32:

```js
const cardSetType = c => (c.printing_status === 'hold' ? 'hold' : c.gang_run_id ? 'gang' : 'single');
```

Add `Layers` to the `lucide-react` import on line 12, and add `cardSetType` to the existing
`SetType.jsx` import so this page stops holding its own copy of the rule.

- [ ] **Step 2: Narrow `zoneOf` to the run kind**

Replace:

```js
  const zoneOf = c => ((c.printing_status === 'hold' || heldRuns.has(c.gang_run_id)) ? 'hold'
    : c.gang_run_id ? 'gang' : 'single');
```

with:

```js
  // Run-level, then the shared card rule. `heldRuns` stays keyed on
  // gang_run_id — a held member parks the whole stack whichever kind of run it
  // is — but what makes a card GANG is the kind, so a combined run lands in
  // Single here exactly as it does on the planning queue.
  const zoneOf = c => (heldRuns.has(c.gang_run_id) ? 'hold' : cardSetType(c));
```

- [ ] **Step 3: Count the combined runs on the unfiltered board**

Immediately after the `zoneCounts` `useMemo`, add:

```js
  // Combined runs in the open zone — the same second axis Planning carries,
  // counted the way the eye counts: a run's stack is one job, however many
  // cards it holds. Hidden at zero, so the press rail does not grow.
  const mergeCount = useMemo(() => {
    const seen = new Set();
    let n = 0;
    for (const c of cards) {
      if (!isMergeRun(c)) continue;
      if (zone !== 'all' && zoneOf(c) !== zone) continue;
      const key = `g${c.gang_run_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      n++;
    }
    return n;
  }, [cards, zone, heldRuns]);
```

`isMergeRun` and `cardSetType` both come from the `SetType.jsx` import updated in Step 1 — this
page must not re-spell either rule locally, which is what it was doing before.

- [ ] **Step 4: Add `mergeOnly` state and apply it in the lane filter**

Beside `const [zone, setZone] = useState('all');` add:

```js
  const [mergeOnly, setMergeOnly] = useState(false); // second axis: combined runs only, composes with the zone
```

In `boardFilterActive`, add `|| mergeOnly` — that variable is a chain of *positive* "a filter is
on" tests.

The `lanes` early-return guard is the opposite shape: a chain of *negative* "nothing is filtering"
tests, so it takes `&& !mergeOnly`, **not** `|| mergeOnly`. Getting this backwards returns the
unfiltered lanes whenever the chip is on, and the chip silently does nothing:

```js
    if (!q && !anyLaneQ && boardStatus === 'all' && !wipOnly && zone === 'all' && !mergeOnly && !anyColourFilter) return fullLanes;
```

Then, after the `zone` filter line inside the loop:

```js
      if (mergeOnly) list = list.filter(isMergeRun);
```

Add `mergeOnly` to that `useMemo`'s dependency array.

- [ ] **Step 5: Render the chip after the zone group**

Directly after the closing `</div>` of the zone chip group, inside the same `{tab === 'board' && (...)}` region, add:

```js
            {mergeCount > 0 && <>
              <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-[#1D1D1F]/[0.10]" />
              <button type="button" onClick={() => { setMergeOnly(v => !v); clearSel(); }}
                title="Combined runs only — one product on several sales orders, printed as one pile"
                aria-pressed={mergeOnly}
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold transition-colors ${
                  mergeOnly
                    ? 'bg-teal-100 text-teal-800 ring-1 ring-teal-200'
                    : 'bg-[#1D1D1F]/[0.05] text-[#6E6E73] hover:bg-[#1D1D1F]/[0.09] hover:text-[#1D1D1F]'}`}>
                <Layers size={11} /> Combined
                <span className={`rounded-full px-1.5 text-[10px] tabular-nums ${mergeOnly ? 'bg-white/25' : 'bg-[#1D1D1F]/[0.07]'}`}>
                  {mergeCount}
                </span>
              </button>
            </>}
```

The zone group is a `<div className="flex shrink-0 items-center gap-1">`; put the new markup
**inside** that div so the divider and chip sit on the same rail.

- [ ] **Step 6: Build**

```bash
cd ~/.config/superpowers/worktrees/ci-erp/combined-is-single && npm run build -w client 2>&1 | tail -5
```

Expected: `✓ built in …`.

---

### Task 7: Full verification

- [ ] **Step 1: Prove no hand-rolled copy of the rule survives**

```bash
cd ~/.config/superpowers/worktrees/ci-erp/combined-is-single && grep -rn "gang_run_id ? 'gang'" client/src server/src
```

Expected: **no output.** Any hit is a third spelling of the classifier and must import the lib
instead — the failure mode `gang-anchor-one-spelling.test.js` exists to prevent.

- [ ] **Step 2: Run the full verify**

```bash
cd ~/.config/superpowers/worktrees/ci-erp/combined-is-single && npm run verify 2>&1 | tail -15
```

Expected: baseline check passes, `# fail 0` at baseline + 17, client builds.

> `npm run verify` runs `build-baseline.mjs --check`. **`--check` writes the baseline** — if it
> reports drift, do not treat a re-run as confirmation; read the diff.

- [ ] **Step 3: Verify in the real app**

Start the dev server via `preview_start` (never Bash), log in, open Planning → To Plan.

| # | Check | Expected |
|---|---|---|
| 1 | Zone chip counts | All **41**, Single **11**, Gang **15**, New Output **5**, Hold **10** |
| 2 | The combined run's row | in **Single**, teal chip, cell reads `2 orders · one pile` |
| 3 | Teal **Combined** chip | present, count **1**; click → 1 row; click again → 11 |
| 4 | Switch to Gang | Combined chip **disappears** (zero merges there) |
| 5 | Switch to Hold | Combined chip returns, count **1** — the held combined run |
| 6 | Combined run's set-type dropdown | offers **New Output** (saves) and **Hold**; does **not** offer Gang |
| 7 | A real gang's dropdown | still offers only Gang and Hold |
| 8 | Print Planning board | same run under **Single**, same teal chip and count |

- [ ] **Step 4: Confirm the API refuses what the menu hides**

With a planner token, PATCH the combined run's line directly:

```bash
curl -s -X PATCH "$API/api/planning/$LINE_ID/set-type" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"set_type":"gang"}'
```

Expected: HTTP 400, body naming the combined run. The UI hiding an option is a courtesy; the
server refusing it is the rule.

- [ ] **Step 5: Report — do NOT commit**

Summarise: suite count before and after, the eight browser checks, and the curl result. Leave the
work on the `combined-is-single` branch, uncommitted. **No commit, no push, no deploy** unless
Anik sanctions it in the current session.

---

## Notes for the implementer

- **`run_kind` is already on both payloads.** `orders.js` LINE_VIEW (`gg.kind AS run_kind`) and
  `floor.js` JC_VIEW / STAGE_VIEW / the print-planning view. No query changes beyond Task 4.
- **Don't "simplify" the merge fall-through.** Pinning a merge to `'single'` in `rowSetType`
  passes four of the five zone tests and silently makes New Output unreachable on a combined
  run. The test that catches it is *"a combined run needing plates is New Output"*.
- **The 15 intent-tagged `gang` lines are not a bug.** They are planners stating an intention to
  gang later, with no run built. They stay exactly as they are.
- **Task 2's tests pass on arrival.** That is by construction, not an error — Task 1 writes the
  lib in its final shape, and what still misclassifies is the two pages holding their own copies.
