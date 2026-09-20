# Parent on Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Both planning engines count cuts on the parent their lock will use. A parent on file that costs cuts
is shown with a one-click fix. A board change carries a parent that only copied the old board's sheet. There
are no new refusals, and every parent change asks "Update Product Master / This job only".

**Architecture:**
- One rule, `parentLosesCuts`, with a server spelling in `helpers.js` and a client twin in `cutFit.js`, pinned
  by a parity test.
- The run engine gets the effective parent through `MEMBER_VIEW`. Both its pre-lock estimate
  (`memberParentSheets`) and its client maths (`gangCalc`) count cuts on `cuttingParent` / `cutParentOf`.
- The Run Sheet gains Parent L/W, which go through the existing Lock sheet master/job prompt.
- Co-printed gang cards take the shared lock's fit.
- `check:parent` lists parents that cost cuts, informationally.

**Tech Stack:** Node (ES modules, `node --test`), Express routes, Postgres (via `server/src/db.js`), React (Vite) in `client/`.

**Spec:** `docs/superpowers/specs/2026-09-19-parent-on-screen-design.md`. Read its "contract" section first.

**Worktree:** `~/.config/superpowers/worktrees/ci-erp/mrg0028-relock`, branch `fix/parent-on-screen`
(off `origin/main` 9bfb3b14). Every path below is relative to it.

**PROJECT RULE — NOTHING SHIPS.** Per `~/Documents/Projects/Colour Imp Production/CLAUDE.md`: no `git commit`,
no `git push` (pushing main deploys motionci.in), no deploy, no migration or data write on prod. Each task ends
with a "Do not commit" step instead of a commit. Work stays on disk until Anik sanctions shipping in the session.

**Baseline before starting:** `cd server && node --test src/*.test.js` gives `# tests 3112 / # pass 3111 / # fail 0`.

**Fixed-window source pins.** `run-leftover-wiring.test.js` slices `gangs.js` by character counts (e.g.
`slice(gangs, 'async function reDeriveMemberSheets', 7000)`). If one fails after your edit and the reason is
that its block moved or grew, not that its rule broke, widen that one number just enough to cover the block
again and say so in your report. Never weaken the regex it asserts.

---

## File map

| File | Change | Responsibility |
|---|---|---|
| `client/src/lib/cutFit.js` | modify (append) | client twins: `sameSheet`, `cutParentOf`, `parentLosesCuts`, `parentFollowsBoard` |
| `server/src/helpers.js` | modify | server rule `parentLosesCuts`; `coPrintedCardCuts`; `memberParentSheets` counts on `cuttingParent`; `createJobCardForGang` stamps co-printed cuts |
| `server/src/routes/gangs.js` | modify | `MEMBER_VIEW` + effective `parent_l/parent_w`; `gangDetail` co-printed exception; `/gang-runs/:id/shared` accepts the parent |
| `client/src/pages/Planning.jsx` | modify | run engine: `gangCalc`, Run Sheet parent fields + warning + one-click, `setGangBoard` carry, prompt row; single engine: warning + one-click, `pickBoard` carry |
| `scripts/check-parent-fit.mjs` | modify | CHECK 1 reads the effective parent; CHECK 3 lists parents that cost cuts (never fails the run) |
| `server/src/parent-on-screen-client.test.js` | create | Task 1 tests |
| `server/src/parent-loses-cuts.test.js` | create | Task 2 tests |
| `server/src/member-parent-estimate.test.js` | create | Task 3 tests |
| `server/src/run-sheet-parent-route.test.js` | create | Task 4 tests |
| `server/src/co-printed-card-cuts.test.js` | create | Task 5 tests |
| `server/src/planning-parent-screen.test.js` | create | Tasks 6 + 7 source pins |
| `server/src/check-parent-fit-lossy.test.js` | create | Task 8 source pins |

Live fixtures used throughout. These were read from prod on 2026-09-19 and each cut count was verified against
both `childFit` and `clientFit`:

| code | parent on file | child | board | cuts on parent | cuts on board |
|---|---|---|---|---|---|
| SW-544 | 22×28 | 12.6×23 (job) | #399 23×38 | 1 | 3 |
| GAL-072 | 22×28 | 13.75×17.75 | #138 31.5×41.5 | 2 | 5 |
| SW-586 | 23×36 | 18×25 | #210 25×36 | 1 | 2 |
| FP-157 | 20×38 | 19×21 | #380 23×38 | 1 | 2 |
| SW-258 | 22×28 | 14×22 | #325 26×30 | 2 | 2 |
| SW-097 | 25.6×28 | 14×25.6 | #52 26.7×28 | 2 | 2 |

---

### Task 1: Client twins in `cutFit.js`

**Files:**
- Modify: `client/src/lib/cutFit.js` (append after `chosenStrips`, end of file)
- Test: `server/src/parent-on-screen-client.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `server/src/parent-on-screen-client.test.js`:

```js
// The client twins the planning screens count cuts with — so the screen and
// the lock measure ONE parent (CI-MRG-0028, 19 Sep 2026: the run screen said
// "Covered" at 3,550 off the 23×38 board; the lock wrote 10,650 off SW-544's
// 22×28 parent on file). Server spellings are pinned against these in
// parent-loses-cuts.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameSheet, cutParentOf, parentLosesCuts, parentFollowsBoard, parentTooBig } from '../../client/src/lib/cutFit.js';

const flat = (p, b) => ({ parentL: p.parent_l, parentW: p.parent_w, boardL: b.sheet_l, boardW: b.sheet_w,
                          childL: p.child_l, childW: p.child_w });
const SW544 = { parent_l: 22, parent_w: 28, child_l: 12.6, child_w: 23 };
const B399 = { sheet_l: 23, sheet_w: 38 };

test('SW-544: the parent on file cuts once where the board cuts three', () => {
  assert.deepEqual(parentLosesCuts(flat(SW544, B399)),
    { declared: { l: 22, w: 28 }, board: { l: 23, w: 38 }, cuts_declared: 1, cuts_board: 3 });
});

test('the other live cases the 19-Sep scan found are named too', () => {
  const gal = parentLosesCuts(flat({ parent_l: 22, parent_w: 28, child_l: 13.75, child_w: 17.75 }, { sheet_l: 31.5, sheet_w: 41.5 }));
  assert.equal(gal.cuts_declared, 2); assert.equal(gal.cuts_board, 5);
  const sw586 = parentLosesCuts(flat({ parent_l: 23, parent_w: 36, child_l: 18, child_w: 25 }, { sheet_l: 25, sheet_w: 36 }));
  assert.equal(sw586.cuts_declared, 1); assert.equal(sw586.cuts_board, 2);
});

test('a trim that keeps every cut is not flagged', () => {
  assert.equal(parentLosesCuts(flat({ parent_l: 22, parent_w: 28, child_l: 14, child_w: 22 }, { sheet_l: 26, sheet_w: 30 })), null);
  assert.equal(parentLosesCuts(flat({ parent_l: 25.6, parent_w: 28, child_l: 14, child_w: 25.6 }, { sheet_l: 26.7, sheet_w: 28 })), null);
});

test('no parent, a blank field, an unsized child, or a parent LARGER than the board is not this rule', () => {
  assert.equal(parentLosesCuts({ ...flat(SW544, B399), parentL: null }), null);
  assert.equal(parentLosesCuts({ ...flat(SW544, B399), parentL: '', parentW: '' }), null);
  assert.equal(parentLosesCuts({ ...flat(SW544, B399), childL: null }), null);
  assert.equal(parentLosesCuts(flat({ ...SW544, parent_l: 25, parent_w: 40 }, B399)), null);
});

test('cutParentOf: the parent on file when the board can yield it, else the board', () => {
  assert.deepEqual(cutParentOf(SW544, B399), { l: 22, w: 28 });
  assert.deepEqual(cutParentOf({ parent_l: null, parent_w: null }, B399), { l: 23, w: 38 });
  assert.deepEqual(cutParentOf({}, B399), { l: 23, w: 38 });
  assert.deepEqual(cutParentOf({ parent_l: 25, parent_w: 40 }, B399), { l: 23, w: 38 });
});

test('cutParentOf reads form strings: blank is the board (the one deliberate difference from the server), digits are numbers', () => {
  assert.deepEqual(cutParentOf({ parent_l: '', parent_w: '' }, B399), { l: 23, w: 38 });
  assert.deepEqual(cutParentOf({ parent_l: '22', parent_w: '28' }, B399), { l: 22, w: 28 });
});

test('unsized boards: cannot judge, so nothing is flagged and the parent on file stands', () => {
  const noBoard = { sheet_l: null, sheet_w: null };
  assert.equal(parentLosesCuts(flat(SW544, noBoard)), null);
  assert.equal(parentTooBig({ parentL: 22, parentW: 28, boardL: null, boardW: null }), false);
  assert.deepEqual(cutParentOf(SW544, noBoard), { l: 22, w: 28 });
});

test('parentTooBig: a parent the board cannot yield', () => {
  assert.equal(parentTooBig({ parentL: 25, parentW: 40, boardL: 23, boardW: 38 }), true);
  assert.equal(parentTooBig({ parentL: 25.6, parentW: 28, boardL: 23, boardW: 38 }), true);
  assert.equal(parentTooBig({ parentL: 22, parentW: 28, boardL: 23, boardW: 38 }), false);
  assert.equal(parentTooBig({ parentL: 38, parentW: 23, boardL: 23, boardW: 38 }), false);   // same sheet turned round
  assert.equal(parentTooBig({ parentL: '', parentW: '', boardL: 23, boardW: 38 }), false);
});

test('null arguments never throw — a render-time throw would blank the Planning page', () => {
  assert.deepEqual(cutParentOf(null, B399), { l: 23, w: 38 });
  assert.equal(parentLosesCuts(null), null);
  assert.equal(parentTooBig(null), false);
  assert.equal(parentFollowsBoard(null), null);
});

test('sameSheet is orientation-free', () => {
  assert.ok(sameSheet({ l: 22, w: 28 }, { l: 28, w: 22 }));
  assert.ok(!sameSheet({ l: 22, w: 28 }, { l: 23, w: 38 }));
  assert.ok(!sameSheet({ l: '', w: '' }, { l: 23, w: 38 }));
});

test('a board change carries a parent that only copied the old board\'s sheet', () => {
  assert.deepEqual(
    parentFollowsBoard({ parent: { l: '22', w: '28' }, oldBoard: { l: 22, w: 28 }, newBoard: { l: 23, w: 38 } }),
    { l: 23, w: 38 });
});

test('a board change carries a parent the new board cannot yield — the lock would only refuse it', () => {
  assert.deepEqual(
    parentFollowsBoard({ parent: { l: 25.6, w: 28 }, oldBoard: { l: 26.7, w: 28 }, newBoard: { l: 23, w: 38 } }),
    { l: 23, w: 38 });
});

test('…and leaves a genuine trim that still fits, a blank parent, a same-size board and an unsized board alone', () => {
  assert.equal(parentFollowsBoard({ parent: { l: 25.6, w: 28 }, oldBoard: { l: 26.7, w: 28 }, newBoard: { l: 26, w: 40 } }), null);
  assert.equal(parentFollowsBoard({ parent: { l: '', w: '' }, oldBoard: { l: 22, w: 28 }, newBoard: { l: 23, w: 38 } }), null);
  assert.equal(parentFollowsBoard({ parent: { l: 22, w: 28 }, oldBoard: { l: 22, w: 28 }, newBoard: { l: 28, w: 22 } }), null);
  assert.equal(parentFollowsBoard({ parent: { l: 22, w: 28 }, oldBoard: { l: 22, w: 28 }, newBoard: { l: null, w: null } }), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && node --test src/parent-on-screen-client.test.js`
Expected: FAIL. `SyntaxError: The requested module '../../client/src/lib/cutFit.js' does not provide an export named 'sameSheet'`

- [ ] **Step 3: Write the implementation**

Append to the end of `client/src/lib/cutFit.js`:

```js
// ── The parent a cut is measured on ─────────────────────────────────────────
// Client twins of helpers.parentFitsBoard / cuttingParent / parentLosesCuts,
// so the planning screens count cuts on the SAME parent the lock does. On
// 19 Sep 2026 CI-MRG-0028 read "Covered" (3,550 sheets, counted on the 23×38
// board) and its lock wrote 10,650 (counted on SW-544's 22×28 parent on file,
// a size left over from its old board). parent-loses-cuts.test.js pins these
// twins against their server originals — change both together.
//
// ONE deliberate difference from the server: a BLANK form field ('') means
// "no parent — the board's full sheet" here. The server only ever sees numbers
// or NULL from the database, and would read '' as an unsized 0×0 sheet.
// Every twin also accepts null arguments: a throw while rendering would take
// the whole Planning page down.

// Same sheet, either way round (23×38 is 38×23). Unsized is never "same".
export function sameSheet(a, b) {
  const al = +a?.l, aw = +a?.w, bl = +b?.l, bw = +b?.w;
  if (!(al > 0 && aw > 0 && bl > 0 && bw > 0)) return false;
  return Math.abs(Math.max(al, aw) - Math.max(bl, bw)) < EPS
      && Math.abs(Math.min(al, aw) - Math.min(bl, bw)) < EPS;
}

// Twin of helpers.parentFitsBoard: can this parent be trimmed out of the
// board? Orientation-free, equal is fine, and unsized answers true ("cannot
// judge" never refuses).
function fitsBoard(pl, pw, bl, bw) {
  if (!(pl > 0 && pw > 0 && bl > 0 && bw > 0)) return true;
  return Math.max(pl, pw) <= Math.max(bl, bw) + EPS && Math.min(pl, pw) <= Math.min(bl, bw) + EPS;
}

const blank = v => v == null || v === '';

// The parent on file does not fit inside its board — an edge too long, either
// way round — so no guillotine can cut it out, and helpers.planLockParent
// refuses the lock (the 14-Sep rule). The planning screens say so BEFORE the
// lock. Blank or unsized answers false: "cannot judge" never warns.
export function parentTooBig(args) {
  const { parentL, parentW, boardL, boardW } = args ?? {};
  if (blank(parentL) || blank(parentW)) return false;
  const pl = +parentL, pw = +parentW, bl = +boardL, bw = +boardW;
  if (!(pl > 0 && pw > 0 && bl > 0 && bw > 0)) return false;
  return !fitsBoard(pl, pw, bl, bw);
}

// Twin of helpers.cuttingParent: the parent on file when there is one and the
// board can yield it, else the board's own sheet.
export function cutParentOf(parent, board) {
  const { parent_l, parent_w } = parent ?? {};
  const bl = +board?.sheet_l, bw = +board?.sheet_w;
  if (blank(parent_l) || blank(parent_w)) return { l: bl, w: bw };
  const pl = +parent_l, pw = +parent_w;
  return fitsBoard(pl, pw, bl, bw) ? { l: pl, w: pw } : { l: bl, w: bw };
}

// Twin of helpers.parentLosesCuts: the parent on file can be trimmed out of
// the board, yet it yields FEWER children than the board's own sheet. A
// WARNING, never a refusal — a deliberate trim is the planner's call (Anik,
// 2026-09-19: no hard blockers in the planning engine).
export function parentLosesCuts(args) {
  const { parentL, parentW, boardL, boardW, childL, childW } = args ?? {};
  if (blank(parentL) || blank(parentW)) return null;
  const pl = +parentL, pw = +parentW, bl = +boardL, bw = +boardW;
  if (!(pl > 0 && pw > 0 && bl > 0 && bw > 0)) return null;
  if (!fitsBoard(pl, pw, bl, bw)) return null;   // does not fit the board: parentTooBig's case
  const onParent = clientFit(pl, pw, childL, childW);
  const onBoard = clientFit(bl, bw, childL, childW);
  if (!onParent || !onBoard || onParent.cpp >= onBoard.cpp) return null;
  return { declared: { l: pl, w: pw }, board: { l: bl, w: bw },
           cuts_declared: onParent.cpp, cuts_board: onBoard.cpp };
}

// A board change carries a parent that cannot stay (spec §4):
//   • a COPY of the OLD board's sheet — SW-544 kept 22×28, board #53's own
//     sheet, after moving to the 23×38 board #399;
//   • a size the NEW board cannot yield — the lock would only refuse it.
// Returns the new board's sheet to put in the parent fields (a fill the
// planner sees, saved only through the usual master/job question), or null
// to leave them alone: a blank parent already follows the board, and a
// genuine trim that still fits is the planner's to keep (the warnings speak
// if it costs cuts).
export function parentFollowsBoard(args) {
  const { parent, oldBoard, newBoard } = args ?? {};
  const nl = +newBoard?.l, nw = +newBoard?.w;
  if (!(nl > 0 && nw > 0)) return null;
  const copied = sameSheet(parent, oldBoard) && !sameSheet(oldBoard, newBoard);
  const tooBig = parentTooBig({ parentL: parent?.l, parentW: parent?.w, boardL: nl, boardW: nw });
  return copied || tooBig ? { l: nl, w: nw } : null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && node --test src/parent-on-screen-client.test.js`
Expected: PASS, `# pass 13`, `# fail 0`.

- [ ] **Step 5: Run the existing cut twins to confirm nothing moved**

Run: `cd server && node --test src/cut-sizing.test.js src/chosen-strips.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 6: Do not commit.** Record in your task report: files changed, tests passing.

---

### Task 2: Server rule `parentLosesCuts` + parity with the client twins

**Files:**
- Modify: `server/src/helpers.js`, inserting after `planLockParent` (it ends with `return parent;\n}` just above `const FIT_EPS = 1e-6;`)
- Test: `server/src/parent-loses-cuts.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `server/src/parent-loses-cuts.test.js`:

```js
// The server spelling of "the parent on file costs cuts", pinned against the
// client twin the planning screens use. Two spellings of one rule are only
// safe while a test holds them together (cut-sizing.test.js does the same for
// childFit/clientFit).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parentLosesCuts, cuttingParent, parentFitsBoard } from './helpers.js';
import { parentLosesCuts as clientLoses, cutParentOf, parentTooBig } from '../../client/src/lib/cutFit.js';

const FIXTURES = [
  ['SW-544',  { parent_l: 22,   parent_w: 28, child_l: 12.6,  child_w: 23 },    { sheet_l: 23,   sheet_w: 38 }],
  ['GAL-072', { parent_l: 22,   parent_w: 28, child_l: 13.75, child_w: 17.75 }, { sheet_l: 31.5, sheet_w: 41.5 }],
  ['SW-586',  { parent_l: 23,   parent_w: 36, child_l: 18,    child_w: 25 },    { sheet_l: 25,   sheet_w: 36 }],
  ['FP-157',  { parent_l: 20,   parent_w: 38, child_l: 19,    child_w: 21 },    { sheet_l: 23,   sheet_w: 38 }],
  ['SW-258',  { parent_l: 22,   parent_w: 28, child_l: 14,    child_w: 22 },    { sheet_l: 26,   sheet_w: 30 }],
  ['SW-097',  { parent_l: 25.6, parent_w: 28, child_l: 14,    child_w: 25.6 },  { sheet_l: 26.7, sheet_w: 28 }],
  ['no parent', { parent_l: null, parent_w: null, child_l: 12.6, child_w: 23 }, { sheet_l: 23,   sheet_w: 38 }],
  ['oversize',  { parent_l: 25,   parent_w: 40, child_l: 12.6, child_w: 23 },   { sheet_l: 23,   sheet_w: 38 }],
  ['one edge over', { parent_l: 25, parent_w: 28, child_l: 12.6, child_w: 23 },  { sheet_l: 23,   sheet_w: 38 }],
  ['unsized board', { parent_l: 22, parent_w: 28, child_l: 12.6, child_w: 23 },  { sheet_l: null, sheet_w: null }],
  ['zero cuts',     { parent_l: 22, parent_w: 28, child_l: 12.6, child_w: 30 },  { sheet_l: 23,   sheet_w: 38 }],
];
const flat = (p, b) => ({ parentL: p.parent_l, parentW: p.parent_w, boardL: b.sheet_l, boardW: b.sheet_w,
                          childL: p.child_l, childW: p.child_w });

test('SW-544 on the server: 1 cut on 22×28, 3 on the board', () => {
  assert.deepEqual(parentLosesCuts(FIXTURES[0][1], FIXTURES[0][2]),
    { declared: { l: 22, w: 28 }, board: { l: 23, w: 38 }, cuts_declared: 1, cuts_board: 3 });
});

test('server rule and client twin agree on every fixture', () => {
  for (const [code, p, b] of FIXTURES) assert.deepEqual(parentLosesCuts(p, b), clientLoses(flat(p, b)), code);
});

test('cutParentOf agrees with cuttingParent on every fixture', () => {
  for (const [code, p, b] of FIXTURES) {
    const s = cuttingParent(p, b);
    assert.deepEqual(cutParentOf(p, b), { l: +s.sheet_l, w: +s.sheet_w }, code);
  }
});

test('parentTooBig agrees with !parentFitsBoard on every fixture that carries a parent', () => {
  for (const [code, p, b] of FIXTURES) {
    if (p.parent_l == null) continue;
    assert.equal(parentTooBig(flat(p, b)), !parentFitsBoard({ sheet_l: p.parent_l, sheet_w: p.parent_w }, b), code);
  }
});

// Absolute, not just parity: dropping the fits-the-board check on BOTH sides
// would keep the two twins agreeing while both became wrong.
test('a parent the board cannot yield is the 14-Sep refusal, not this rule, on both sides', () => {
  const [, p, b] = FIXTURES.find(([c]) => c === 'one edge over');
  assert.equal(parentLosesCuts(p, b), null);
  assert.equal(clientLoses(flat(p, b)), null);
});

test('a child the parent cannot hold at all reads 0 cuts, not "unsized"', () => {
  const [, p, b] = FIXTURES.find(([c]) => c === 'zero cuts');
  assert.deepEqual(parentLosesCuts(p, b),
    { declared: { l: 22, w: 28 }, board: { l: 23, w: 38 }, cuts_declared: 0, cuts_board: 1 });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && node --test src/parent-loses-cuts.test.js`
Expected: FAIL. `SyntaxError: The requested module './helpers.js' does not provide an export named 'parentLosesCuts'`

- [ ] **Step 3: Write the implementation**

In `server/src/helpers.js`, insert directly after the closing `}` of `export function planLockParent(...)`,
before `const FIT_EPS = 1e-6;`:

```js
// The parent on file COSTS CUTS: it can be trimmed out of the board (so
// planLockParent lets it through), yet it yields fewer children than the
// board's own sheet. CI-MRG-0028, 19 Sep 2026: SW-544 kept 22×28 — the sheet
// of its OLD board #53 — after "Lock sheet" moved it to the 23×38 board #399.
// A 12.6×23 child fits 22×28 once and 23×38 three times, so the run lock wrote
// 10,650 parent sheets for a job that needs 3,550.
//
// NOT a refusal. Anik's rule (19 Sep 2026): no hard blockers in the planning
// engine — a deliberate trim is the planner's call. This is a fact to SHOW:
// check:parent lists it, and the planning screens warn with its client twin
// (client/src/lib/cutFit.js parentLosesCuts — parent-loses-cuts.test.js holds
// the two together) and offer the board's full sheet.
export function parentLosesCuts(product, board) {
  if (product?.parent_l == null || product?.parent_w == null) return null;
  const declared = { sheet_l: +product.parent_l, sheet_w: +product.parent_w };
  const bl = +board?.sheet_l, bw = +board?.sheet_w;
  if (!(declared.sheet_l > 0 && declared.sheet_w > 0 && bl > 0 && bw > 0)) return null;
  if (!parentFitsBoard(declared, board)) return null;   // does not fit inside the board (an edge too long, either way round): planLockParent refuses that
  const onParent = childFit(declared, product);
  const onBoard = childFit({ sheet_l: bl, sheet_w: bw }, product);
  if (!onParent.sized || !onBoard.sized || onParent.count >= onBoard.count) return null;
  return { declared: { l: declared.sheet_l, w: declared.sheet_w }, board: { l: bl, w: bw },
           cuts_declared: onParent.count, cuts_board: onBoard.count };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && node --test src/parent-loses-cuts.test.js`
Expected: PASS, `# pass 6`, `# fail 0`.

- [ ] **Step 5: Do not commit.**

---

### Task 3: The run engine's pre-lock estimate counts on the lock's parent

**Files:**
- Modify: `server/src/helpers.js`, the `export function memberParentSheets(m)` body
- Modify: `server/src/routes/gangs.js`: `MEMBER_VIEW` (after the `... AS child_w,` line), and `gangDetail` (the line `const withSheets = members.map(m => ({ ...m, parent_sheets: memberParentSheets(m) }));`)
- Test: `server/src/member-parent-estimate.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `server/src/member-parent-estimate.test.js`:

```js
// Before a run is locked, gangDetail's Board Position quotes memberParentSheets
// for every pending member. It counted cuts on the bare BOARD while the lock
// counted them on the parent on file — so CI-MRG-0028 read "Covered" at 3,550
// and the lock wrote 10,650. The estimate must be the lock's own arithmetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { memberParentSheets, planLockParent, childFit, sheetsRequired, parentSheetsRequired } from './helpers.js';

// SW-544's lead member as MEMBER_VIEW carries it once the parent columns exist.
const MEMBER = { parent_sheets_required: null, sheets_required: null, ups: 2, wastage_pct: 0,
                 qty: 10100, fg_consumed_qty: 0, dispatched_qty: 0, wastage_sheets: 350,
                 sheet_l: 23, sheet_w: 38, child_l: 12.6, child_w: 23, parent_l: 22, parent_w: 28 };

test('the lead member\'s pre-lock estimate IS the lock\'s figure when a parent is on file', () => {
  const eff = { parent_l: 22, parent_w: 28, child_l: 12.6, child_w: 23, ups: 2 };
  const lock = parentSheetsRequired(sheetsRequired(eff, 10100, 350),
                                    childFit(planLockParent(eff, { sheet_l: 23, sheet_w: 38 }), eff).count);
  assert.equal(lock, 5400);
  assert.equal(memberParentSheets(MEMBER), lock);
});

test('no parent on file: the board\'s own sheet, as before (1,800)', () => {
  assert.equal(memberParentSheets({ ...MEMBER, parent_l: null, parent_w: null }), 1800);
});

test('a row without the parent columns (older callers) is unchanged', () => {
  const { parent_l, parent_w, ...older } = MEMBER;
  assert.equal(memberParentSheets(older), 1800);
});

const GANGS = readFileSync(new URL('./routes/gangs.js', import.meta.url), 'utf8');

test('MEMBER_VIEW carries the effective parent (job override, else master)', () => {
  const start = GANGS.indexOf('const MEMBER_VIEW = `');
  const VIEW = GANGS.slice(start, GANGS.indexOf('`;', start));
  assert.match(VIEW, /COALESCE\(\(ol\.spec_override->>'parent_l'\)::float, p\.parent_l\) AS parent_l/);
  assert.match(VIEW, /COALESCE\(\(ol\.spec_override->>'parent_w'\)::float, p\.parent_w\) AS parent_w/);
});

test('a co-printed run keeps its estimate on the board, as its lock does', () => {
  // Scoped to gangDetail — the plan route already has its own `coPrinted` line.
  const detail = GANGS.slice(GANGS.indexOf('export async function gangDetail'),
                             GANGS.indexOf('const mix = await gangMixContext(gang, withSheets'));
  assert.match(detail, /const coPrinted = gang\.kind !== 'merge' && gang\.layout_mode === 'shared';/);
  assert.match(detail, /memberParentSheets\(coPrinted \? \{ \.\.\.m, parent_l: null, parent_w: null \} : m\)/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && node --test src/member-parent-estimate.test.js`
Expected: FAIL on 3 tests.
- `the lead member's pre-lock estimate IS the lock's figure`: `1800 !== 5400`
- `MEMBER_VIEW carries the effective parent`: no match
- `a co-printed run keeps its estimate on the board`: no match

The other two pass already.

- [ ] **Step 3: Change `memberParentSheets`**

In `server/src/helpers.js`, replace:

```js
  const fit = childFit({ sheet_l: m?.sheet_l, sheet_w: m?.sheet_w },
                       { child_l: m?.child_l, child_w: m?.child_w });
  return parentSheetsRequired(child, fit.count);
}
```

with:

```js
  // Counted on the parent the LOCK cuts on — cuttingParent over the member's
  // parent on file (MEMBER_VIEW carries it) — never the bare board. Counting
  // the board here is how CI-MRG-0028 read "Covered" at 3,550 while its lock
  // wrote 10,650 off SW-544's 22×28 parent: one screen, two sheets. A row with
  // no parent columns reads as "no parent on file", i.e. the board, as before.
  // A parent the board cannot yield is estimated on the board (cuttingParent's
  // fallback) — the lock refuses that one outright, and the screens say so.
  const parent = cuttingParent({ parent_l: m?.parent_l, parent_w: m?.parent_w },
                               { sheet_l: m?.sheet_l, sheet_w: m?.sheet_w });
  const fit = childFit(parent, { child_l: m?.child_l, child_w: m?.child_w });
  return parentSheetsRequired(child, fit.count);
}
```

- [ ] **Step 4: Add the parent to `MEMBER_VIEW`**

In `server/src/routes/gangs.js`, directly after the line
`         COALESCE((ol.spec_override->>'child_w')::float, p.child_w) AS child_w,`, add:

```sql
         COALESCE((ol.spec_override->>'parent_l')::float, p.parent_l) AS parent_l,
         COALESCE((ol.spec_override->>'parent_w')::float, p.parent_w) AS parent_w,
```

- [ ] **Step 5: Keep co-printed runs on the board in `gangDetail`**

In `server/src/routes/gangs.js`, replace:

```js
  const withSheets = members.map(m => ({ ...m, parent_sheets: memberParentSheets(m) }));
```

with:

```js
  // Every member's estimate counts on the parent its LOCK will cut on — except
  // a co-printed run, whose lock cuts the shared child on the board's own
  // sheet and never reads a member's parent on file (see the plan route's
  // shared arm), so neither may its estimate.
  const coPrinted = gang.kind !== 'merge' && gang.layout_mode === 'shared';
  const withSheets = members.map(m => ({ ...m, parent_sheets: memberParentSheets(coPrinted ? { ...m, parent_l: null, parent_w: null } : m) }));
```

- [ ] **Step 6: Check nothing else on the server reads a member row's parent**

Run: `grep -n "effectiveParent(m\b\|cuttingParent(m\b\|planLockParent(m\b\|effectiveParent(member" server/src/routes/gangs.js server/src/gang-suggest.js server/src/helpers.js`
Expected: no output. Gang suggestions read `MEMBER_VIEW` through the injected `memberParentSheets`, so they
pick up the new estimate with no further change. That is intended.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd server && node --test src/member-parent-estimate.test.js src/parent-demand.test.js src/shared-layout.test.js src/run-leftover-wiring.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 8: Do not commit.**

---

### Task 4: Lock sheet (`POST /gang-runs/:id/shared`) carries the parent

**Files:**
- Modify: `server/src/routes/gangs.js`: the `/gang-runs/:id/shared` route's patch building and its master SELECT
- Test: `server/src/run-sheet-parent-route.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `server/src/run-sheet-parent-route.test.js`:

```js
// The Run Sheet's Lock sheet → is the run engine's ONE door for a sheet change,
// and it asks the planner "Update Product Master / These jobs only". It wrote
// board, child and coating — never the parent — which is how SW-544 moved to
// the 23×38 board on 18 Sep 2026 with its old board's 22×28 parent left behind.
// The parent now travels through the same door, answering the same question.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const GANGS = readFileSync(new URL('./routes/gangs.js', import.meta.url), 'utf8');
const route = GANGS.slice(GANGS.indexOf("r.post('/gang-runs/:id/shared'"),
                          GANGS.indexOf("r.get('/gang-runs/:id/smart-match'"));

test('the route takes a parent size, like the child size', () => {
  assert.match(route, /patch\.parent_l = \+req\.body\.parent_l/);
  assert.match(route, /patch\.parent_w = \+req\.body\.parent_w/);
});

test('both sides or neither — a half parent is refused as bad input', () => {
  assert.match(route, /Parent size needs both length and width/);
  assert.match(route, /Parent size must be greater than zero/);
});

test('the master comparison reads the parent too, so "equal to master" drops the override', () => {
  assert.match(route, /SELECT board_material_id, child_l, child_w, coating, parent_l, parent_w FROM products WHERE id=\$1/);
});

test('a co-printed run never has a parent written onto its products (its lock never reads one)', () => {
  assert.match(route, /if \(gang\.kind !== 'merge' && gang\.layout_mode === 'shared'\) \{ delete patch\.parent_l; delete patch\.parent_w; \}/);
});

test('a request left empty by the co-printed guard changes nothing', () => {
  const inTx = route.slice(route.indexOf('await tx('));
  const guard = inTx.indexOf('delete patch.parent_l; delete patch.parent_w; }');
  const early = inTx.indexOf('if (!Object.keys(patch).length) return;');
  assert.ok(guard > 0 && early > guard, 'the empty-patch return must follow the co-printed guard inside the transaction');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && node --test src/run-sheet-parent-route.test.js`
Expected: FAIL on all 5 tests.

- [ ] **Step 3: Write the implementation**

In `server/src/routes/gangs.js`, inside `r.post('/gang-runs/:id/shared', ...)`, replace:

```js
    if (req.body.coating != null && req.body.coating !== '') patch.coating = String(req.body.coating);
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to lock' });
    if ((patch.child_l != null && !(patch.child_l > 0)) || (patch.child_w != null && !(patch.child_w > 0)))
      return res.status(400).json({ error: 'Child size must be greater than zero' });
```

with:

```js
    if (req.body.coating != null && req.body.coating !== '') patch.coating = String(req.body.coating);
    // The parent the run cuts on — typed in the Run Sheet, or the board's own
    // sheet sent by "Use the board's full sheet" (or by blanking a parent on
    // file). A blank means "no change" here, never "clear": the client says
    // "the board's full sheet" with the board's own dims. It rides the loop
    // below exactly like the child size: equal to master → the override goes;
    // update master → the master; otherwise a job-only override. Same question.
    if (req.body.parent_l != null && req.body.parent_l !== '') patch.parent_l = +req.body.parent_l;
    if (req.body.parent_w != null && req.body.parent_w !== '') patch.parent_w = +req.body.parent_w;
    if (('parent_l' in patch) !== ('parent_w' in patch))
      return res.status(400).json({ error: 'Parent size needs both length and width' });
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to lock' });
    if ((patch.child_l != null && !(patch.child_l > 0)) || (patch.child_w != null && !(patch.child_w > 0)))
      return res.status(400).json({ error: 'Child size must be greater than zero' });
    if ((patch.parent_l != null && !(patch.parent_l > 0)) || (patch.parent_w != null && !(patch.parent_w > 0)))
      return res.status(400).json({ error: 'Parent size must be greater than zero' });
```

In the same route, replace:

```js
        const master = await oc('SELECT board_material_id, child_l, child_w, coating FROM products WHERE id=$1', [line.product_id]);
```

with:

```js
        const master = await oc('SELECT board_material_id, child_l, child_w, coating, parent_l, parent_w FROM products WHERE id=$1', [line.product_id]);
```

In the same route, directly after the unique line `      if (!card) await assertPlanningOnlyGangEdit(gang.id, oc);`, add:

```js
      // A co-printed run cuts the shared child on the board's own sheet and
      // never reads a parent on file (its lock and re-derive measure the board),
      // so a parent sent for one is ignored — never written onto its products.
      if (gang.kind !== 'merge' && gang.layout_mode === 'shared') { delete patch.parent_l; delete patch.parent_w; }
      // Nothing left to lock (a parent-only request to a co-printed run): leave
      // the run exactly as it is — no re-derive, no empty audit line.
      if (!Object.keys(patch).length) return;
```

(The loop `for (const [f, v] of Object.entries(patch))` needs no change: `parent_l`/`parent_w` take the same
master-vs-job path as `child_l`/`child_w`. `keepExplicit` applies to child fields only, as it should.
`reDeriveMemberSheets` already runs after, on `cuttingParent`, so planned members' figures follow the new parent.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && node --test src/run-sheet-parent-route.test.js src/run-leftover-wiring.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Do not commit.**

---

### Task 5: A co-printed gang's card carries the cuts its lock planned

**Files:**
- Modify: `server/src/helpers.js`: add `coPrintedCardCuts` right after `parentLosesCuts` (Task 2); change `createJobCardForGang`
- Test: `server/src/co-printed-card-cuts.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `server/src/co-printed-card-cuts.test.js`:

```js
// A co-printed (shared-layout) gang's lock prices the run on the SHARED child
// cut from the board's own sheet (gangs.js plan route, shared arm). Its card
// stamped children_per_parent from readiness(lead) instead, which counts on
// the lead's parent on file. CI-GANG-0019's shape (FP-157: parent 20×38 on
// the 23×38 board, child 19×21): the lock plans 2 per parent, the card would
// tell cutting 1 — half the print sheets the job needs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { coPrintedCardCuts, cuttingParent, childFit, createJobCardForGang } from './helpers.js';

const FP157 = { parent_l: 20, parent_w: 38, child_l: 19, child_w: 21 };
const B380 = { sheet_l: 23, sheet_w: 38 };

test('the mismatch is real: readiness counts 1, the co-printed lock 2', () => {
  assert.equal(childFit(cuttingParent(FP157, B380), FP157).count, 1);
  assert.equal(childFit(B380, FP157).count, 2);
});

test('coPrintedCardCuts is the divisor the co-printed lock used', () => {
  assert.equal(coPrintedCardCuts(B380, { l: 19, w: 21 }), 2);
  // parentSheetsRequired clamps an unsized or a zero fit to 1 — so does the card.
  assert.equal(coPrintedCardCuts({ sheet_l: null, sheet_w: 38 }, { l: 19, w: 21 }), 1);
  assert.equal(coPrintedCardCuts(B380, { l: 30, w: 40 }), 1);
});

const HELPERS = readFileSync(new URL('./helpers.js', import.meta.url), 'utf8');
const fn = HELPERS.slice(HELPERS.indexOf('export async function createJobCardForGang'),
                         HELPERS.indexOf('export async function createJobCardForMergeRun'));

test('createJobCardForGang stamps coPrintedCardCuts on a co-printed run', () => {
  assert.match(fn, /sharedChild = ov\[0\];/);
  assert.match(fn, /cardCuts = coPrintedCardCuts\(board, sharedChild\);/);
  assert.match(fn, /anchor\.machine_id, totalChild, totalParent,\s*cardCuts, totalChild\]/);
});

// ── Behaviour, not text ─────────────────────────────────────────────────────
// The REAL createJobCardForGang, driven with stub qc/oc (no database), reading
// back what its job_cards INSERT would write. The text pin above let a flipped
// kind check and a wrong board id through in review (19 Sep 2026); these do not.
// Every statement the function issues is answered; an unrecognised one fails
// the test, so the stub cannot quietly hand back null.
function pushCard({ gang, board, products, lines }) {
  const inserts = [];
  const unknown = [];
  const byId = (arr, id) => arr.find(x => +x.id === +id) || null;
  const oc = async (sql, p = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (/FROM job_cards WHERE gang_run_id=\$1 AND parent_job_card_id IS NULL/.test(s)) return null;
    if (/^SELECT \* FROM gang_runs WHERE id=\$1/.test(s)) return gang;
    if (/^SELECT \* FROM products WHERE id=\$1/.test(s)) return byId(products, p[0]);
    if (/^SELECT \* FROM materials WHERE id=\$1/.test(s)) return +p[0] === board.id ? board : null;
    if (/^SELECT sheet_l, sheet_w FROM materials WHERE id=\$1/.test(s)) return +p[0] === board.id ? { sheet_l: board.sheet_l, sheet_w: board.sheet_w } : null;
    if (/FROM stock_batches WHERE material_id=\$1 AND status='available'/.test(s)) return { q: 1e9 };
    if (/FROM tools t WHERE t.product_id/.test(s)) return { list: [] };
    if (/FROM tooling_requests tr JOIN plate_request_components/.test(s)) return null;
    if (/FROM shade_cards/.test(s)) return null;
    if (/FROM requisitions/.test(s)) return { qty: 0 };
    if (/FROM job_board_mix x WHERE x.order_line_id/.test(s)) return { list: [] };
    if (/^SELECT \* FROM order_lines WHERE id=\$1/.test(s)) return byId(lines, p[0]);
    if (/pg_advisory_xact_lock/.test(s)) return {};
    if (/^SELECT jc_number AS n FROM job_cards/.test(s)) return null;
    unknown.push(s.slice(0, 90));
    return null;
  };
  const qc = async (sql, p = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (/^SELECT ol\.\* FROM order_lines ol WHERE ol\.gang_run_id=\$1/.test(s)) return lines.map(l => ({ ...l }));
    if (/^UPDATE order_lines SET status/.test(s)) { const l = byId(lines, p[1]); if (l) l.status = p[0]; return []; }
    if (/^INSERT INTO job_cards/.test(s)) { inserts.push(p); return [{ id: 9001 }]; }
    if (/^INSERT INTO job_stages/.test(s)) return [];
    if (/^INSERT INTO audit_log/.test(s)) return [];
    unknown.push('qc: ' + s.slice(0, 90));
    return [];
  };
  return createJobCardForGang(gang.id, qc, oc, 'test').then(
    () => ({ cpp: inserts[0]?.[6], unknown }),
    e => ({ error: `${e.status || ''} ${e.message}`, unknown }));
}

const BOARD380 = { id: 380, name: 'Met Saffire 23x38', sheet_l: 23, sheet_w: 38 };
const master = (id, code, extra = {}) => ({ id, code, name: code, ups: 4, child_l: 19, child_w: 21,
  parent_l: 20, parent_w: 38, board_material_id: 380, wastage_pct: 5, pasting_type: 'lock bottom', ...extra });
const line = (id, product_id, extra = {}) => ({ id, product_id, machine_id: 3, gang_run_id: 19, qty: 10000,
  status: 'planned', artwork_locked: 1, tooling_ok: 1, stock_booking: 'book', wastage_sheets: 0,
  fg_consumed_qty: 0, dispatched_qty: 0,
  sheets_required: 1300, parent_sheets_required: 650,   // the co-printed lock: 2 cuts on 23×38
  spec_override: JSON.stringify({ child_l: 19, child_w: 21 }), ...extra });
const GANG = { id: 19, gang_number: 'CI-GANG-0019', kind: 'gang', layout_mode: 'shared' };
const PRODUCTS = [master(157, 'FP-157'), master(216, 'FP-216')];

test('behaviour: a co-printed card carries its lock\'s 2 cuts; a separate-layout card keeps readiness\'s 1', async () => {
  const shared = await pushCard({ gang: GANG, board: BOARD380, products: PRODUCTS,
    lines: [line(328, 157), line(394, 216)] });
  assert.equal(shared.error, undefined);
  assert.deepEqual(shared.unknown, []);
  assert.equal(shared.cpp, 2);
  const separate = await pushCard({ gang: { ...GANG, layout_mode: 'separate' }, board: BOARD380, products: PRODUCTS,
    lines: [line(328, 157, { spec_override: null }), line(394, 216, { spec_override: null })] });
  assert.deepEqual(separate.unknown, []);
  assert.equal(separate.cpp, 1);
});

test('behaviour: an unsized board or a child bigger than the board gives the lock\'s clamp, 1', async () => {
  const unsized = await pushCard({ gang: GANG, board: { id: 380, name: 'placeholder', sheet_l: null, sheet_w: null },
    products: [master(157, 'FP-157', { parent_l: 25, parent_w: 36, child_l: 12, child_w: 18 }),
               master(216, 'FP-216', { parent_l: 25, parent_w: 36, child_l: 12, child_w: 18 })],
    lines: [line(328, 157, { spec_override: JSON.stringify({ child_l: 12, child_w: 18 }) }),
            line(394, 216, { spec_override: JSON.stringify({ child_l: 12, child_w: 18 }) })] });
  assert.deepEqual(unsized.unknown, []);
  assert.equal(unsized.cpp, 1);
  const tooBig = await pushCard({ gang: GANG, board: BOARD380,
    products: [master(157, 'FP-157', { parent_l: null, parent_w: null }), master(216, 'FP-216', { parent_l: null, parent_w: null })],
    lines: [line(328, 157, { spec_override: JSON.stringify({ child_l: 30, child_w: 40 }) }),
            line(394, 216, { spec_override: JSON.stringify({ child_l: 30, child_w: 40 }) })] });
  assert.deepEqual(tooBig.unknown, []);
  assert.equal(tooBig.cpp, 1);
});

test('behaviour: a co-printed run with its layout pending still refuses the push', async () => {
  const pending = await pushCard({ gang: GANG, board: BOARD380, products: PRODUCTS,
    lines: [line(328, 157), line(394, 216, { spec_override: null })] });
  assert.match(pending.error, /Layout Pending/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && node --test src/co-printed-card-cuts.test.js`
Expected: FAIL. `SyntaxError: ... does not provide an export named 'coPrintedCardCuts'`

- [ ] **Step 3: Add `coPrintedCardCuts`**

In `server/src/helpers.js`, directly after the `parentLosesCuts` function added in Task 2:

```js
// The cuts a CO-PRINTED run's card must carry: the shared child on the board's
// own sheet — exactly the divisor its lock priced the run with (gangs.js plan
// route, shared arm: parentSheetsRequired(run_child, childFit(board, child)
// .count), which clamps an unsized or a zero fit to 1, as this does).
// readiness() counts on the lead member's parent on file instead; on
// CI-GANG-0019's shape that is 1 where the lock planned 2.
export function coPrintedCardCuts(board, sharedChild) {
  const fit = childFit({ sheet_l: board?.sheet_l, sheet_w: board?.sheet_w },
                       { child_l: sharedChild?.l, child_w: sharedChild?.w });
  return Math.max(1, fit.count || 1);
}
```

- [ ] **Step 4: Use it in `createJobCardForGang`**

In `server/src/helpers.js`, inside `export async function createJobCardForGang`, replace:

```js
  const gangRow = await oc('SELECT * FROM gang_runs WHERE id=$1', [gangRunId]);
  if (gangRow?.layout_mode === 'shared') {
```

with:

```js
  const gangRow = await oc('SELECT * FROM gang_runs WHERE id=$1', [gangRunId]);
  let sharedChild = null;   // the settled layout's child — the card's cut is measured on it below
  if (gangRow?.layout_mode === 'shared') {
```

In the same block, replace (this anchor is unique; `const gates = [];` alone is not, since it appears twice
in `helpers.js`):

```js
      const e = new Error(`${gangRow.gang_number} is Layout Pending — enter the final child sheet size before pushing the job card`);
      e.status = 409;
      throw e;
    }
  }
```

with:

```js
      const e = new Error(`${gangRow.gang_number} is Layout Pending — enter the final child sheet size before pushing the job card`);
      e.status = 409;
      throw e;
    }
    sharedChild = ov[0];
  }
```

Then replace:

```js
    [jc_number, gangRunId, anchor.product_id, anchor.machine_id, totalChild, totalParent,
     Math.max(1, gates[0]?.children_per_parent || 1), totalChild]);
```

with:

```js
    [jc_number, gangRunId, anchor.product_id, anchor.machine_id, totalChild, totalParent,
     cardCuts, totalChild]);
```

and immediately BEFORE the line `const jc_number = await nextNumber('CI-GANG-JC-', 'job_cards', 'jc_number', oc);` add:

```js
  // The card's cut is the one its LOCK used. For every ordinary gang that is
  // readiness()'s figure. A co-printed run's lock measured the shared child on
  // the board's own sheet, never a member's parent on file — so its card does
  // too (coPrintedCardCuts), or cutting is told a different count than the plan.
  let cardCuts = Math.max(1, gates[0]?.children_per_parent || 1);
  if (sharedChild && gangRow?.kind !== 'merge') {
    const board = await oc('SELECT sheet_l, sheet_w FROM materials WHERE id=$1', [anchorProduct.board_material_id]);
    cardCuts = coPrintedCardCuts(board, sharedChild);
  }
```

(`anchorProduct` is declared above that line as `const anchorProduct = products[0];`. Confirm with
`grep -n "const anchorProduct = products\[0\]" server/src/helpers.js`.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && node --test src/co-printed-card-cuts.test.js src/shared-layout.test.js`
Expected: PASS, `# fail 0` (6 tests in the new file).

- [ ] **Step 6: Do not commit.**

---

### Task 6: Run engine: count on the saved parent; Run Sheet parent fields, warning, one-click fix, board carry

**Files:**
- Modify: `client/src/pages/Planning.jsx` (seven places, each quoted exactly below)
- Test: `server/src/planning-parent-screen.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `server/src/planning-parent-screen.test.js`:

```js
// Source pins for the planning screens: .jsx cannot be imported by node --test,
// so the RULES live in client/src/lib/cutFit.js (tested directly) and these
// pins hold the screens to calling them. CI-MRG-0028 is the reason: the run
// screen counted the board while the lock counted the parent on file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const P = readFileSync(new URL('../../client/src/pages/Planning.jsx', import.meta.url), 'utf8');
const between = (a, b) => { const i = P.indexOf(a); assert.ok(i >= 0, `missing: ${a}`); return P.slice(i, P.indexOf(b, i)); };

test('Planning imports the parent twins from cutFit.js', () => {
  assert.match(P, /import \{ clientStrips, chosenCutsValid, chosenStrips, cutParentOf, parentLosesCuts, parentFollowsBoard, parentTooBig \} from '\.\.\/lib\/cutFit\.js';/);
});

test('gangCalc counts each member on the parent its lock cuts on', () => {
  const block = between('const gangCalc = useMemo', 'const position = useMemo');
  assert.match(block, /cutParentOf\(m, board\)/);
  assert.doesNotMatch(block, /clientFit\(anchor\?\.sheet_l, anchor\?\.sheet_w, \+m\.child_l/);
});

test('the Run Sheet form holds the parent, seeded from the saved one', () => {
  assert.match(P, /useState\(\{ child_l: '', child_w: '', coating: '', parent_l: '', parent_w: '' \}\)/);
  assert.match(between('const seedGangSheet', 'const seedGangNumbers'), /parent_l: d\.members\?\.\[0\]\?\.parent_l != null/);
});

test('Lock sheet sends the parent only when it changed, never for a co-printed run; blank over a parent on file is the board\'s sheet', () => {
  const block = between('const lockGangSheet', 'const applyGangSheet');
  assert.match(block, /const parent = coPrinted \|\| !\(changed \|\| forced\) \? \{\}/);
  assert.match(block, /const forced = over\.parent_l != null && over\.parent_w != null;/);
  assert.match(block, /gangView\.kind === 'merge' \? \(gangView\.members \|\| \[\]\)\.some\(differs\)/);
  assert.match(block, /parent_l: String\(anchor\.sheet_l\), parent_w: String\(anchor\.sheet_w\)/);
  assert.match(block, /\.\.\.parent,/);
  assert.match(P, /<span className="font-semibold text-slate-700">Parent sheet<\/span>/);
});

test('the Run Sheet warns when the saved parent costs cuts or is larger than its board, with the one-click fix', () => {
  const sheet = between('const flagged = coPrinted', 'Lock sheet →');
  assert.match(sheet, /parentLosesCuts\(args\)/);
  assert.match(sheet, /parentTooBig\(args\)/);
  assert.match(sheet, /is larger than the/);
  assert.match(sheet, /Use the board's full sheet/);
});

test('a run board change carries a parent that cannot stay on the new board', () => {
  assert.match(between('const setGangBoard', 'const lockGangSheet'), /parentFollowsBoard\(/);
});

test('Lock sheet catches a half-typed parent before asking; the one-click needs a sized board', () => {
  assert.match(between('const lockGangSheet', 'const applyGangSheet'),
    /if \(!coPrinted && \(changed \|\| forced\) && isBlank\(pl\) !== isBlank\(pw\)\)/);
  assert.match(between('const useBoardSheet', 'lockGangSheet(over)'),
    /if \(!\(\+anchor\?\.sheet_l > 0 && \+anchor\?\.sheet_w > 0\)\)/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && node --test src/planning-parent-screen.test.js`
Expected: FAIL on all 7 tests.

- [ ] **Step 3: Import the twins**

In `client/src/pages/Planning.jsx`, replace:

```js
import { clientStrips, chosenCutsValid, chosenStrips } from '../lib/cutFit.js';
```

with:

```js
import { clientStrips, chosenCutsValid, chosenStrips, cutParentOf, parentLosesCuts, parentFollowsBoard, parentTooBig } from '../lib/cutFit.js';
```

- [ ] **Step 4: The Run Sheet form holds the parent**

Replace:

```js
  const [gangSheetForm, setGangSheetForm] = useState({ child_l: '', child_w: '', coating: '' }); // unified gang sheet lock (child + coating)
```

with:

```js
  const [gangSheetForm, setGangSheetForm] = useState({ child_l: '', child_w: '', coating: '', parent_l: '', parent_w: '' }); // unified gang sheet lock (child + coating + parent)
```

Replace:

```js
  const seedGangSheet = d => setGangSheetForm({
    child_l: d.members?.[0]?.child_l != null ? String(d.members[0].child_l) : '',
    child_w: d.members?.[0]?.child_w != null ? String(d.members[0].child_w) : '',
    coating: d.members?.[0]?.coating || '',
  });
```

with:

```js
  const seedGangSheet = d => setGangSheetForm({
    child_l: d.members?.[0]?.child_l != null ? String(d.members[0].child_l) : '',
    child_w: d.members?.[0]?.child_w != null ? String(d.members[0].child_w) : '',
    coating: d.members?.[0]?.coating || '',
    // The parent ON FILE (MEMBER_VIEW's effective parent) — blank means the
    // board's full sheet. Shown so the run never cuts on a parent nobody sees.
    parent_l: d.members?.[0]?.parent_l != null ? String(d.members[0].parent_l) : '',
    parent_w: d.members?.[0]?.parent_w != null ? String(d.members[0].parent_w) : '',
  });
```

- [ ] **Step 5: `gangCalc` counts on the parent the lock uses**

In `const gangCalc = useMemo(() => {`, replace:

```js
    const anchor = gangView.members[0];
    let baseChild = 0, childSheets = 0, parent = 0;
```

with:

```js
    const anchor = gangView.members[0];
    // A co-printed run's lock cuts the shared child on the board's own sheet
    // and never reads a member's parent on file; every other run's lock cuts
    // each member on ITS parent (planLockParent) — so must this screen.
    const coPrinted = gangView.kind !== 'merge' && gangView.layout_mode === 'shared';
    let baseChild = 0, childSheets = 0, parent = 0;
```

and replace:

```js
      const fit = clientFit(anchor?.sheet_l, anchor?.sheet_w, +m.child_l || +anchor?.child_l, +m.child_w || +anchor?.child_w);
```

with:

```js
      // Each member on the parent its lock cuts on: the parent on file when its
      // own board can yield it, else that board's sheet (cutParentOf, twin of
      // cuttingParent). The bare anchor board here is how CI-MRG-0028 said
      // "Covered" at 3,550 while its lock wrote 10,650 off a 22×28 parent.
      const board = { sheet_l: m.sheet_l ?? anchor?.sheet_l, sheet_w: m.sheet_w ?? anchor?.sheet_w };
      const par = coPrinted ? { l: +board.sheet_l, w: +board.sheet_w } : cutParentOf(m, board);
      const fit = clientFit(par.l, par.w, +m.child_l || +anchor?.child_l, +m.child_w || +anchor?.child_w);
```

- [ ] **Step 6: A run board change carries a copied parent into the Run Sheet**

Replace:

```js
  const setGangBoard = async board => {
    const boardId = board.id ?? board.material_id;
    const d = await api.post(`/gang-runs/${gangView.id}/board`, { board_material_id: boardId });
    toast.success(`${d.gang_number} — board set to ${board.name} for all ${d.members.length} jobs`);
    setGangView(d); seedGangEdits(d); seedGangMix(d); seedGangSheet(d); setGangWhOpen(false); load();
  };
```

with:

```js
  const setGangBoard = async board => {
    const boardId = board.id ?? board.material_id;
    const before = gangView?.members?.[0];
    const d = await api.post(`/gang-runs/${gangView.id}/board`, { board_material_id: boardId });
    toast.success(`${d.gang_number} — board set to ${board.name} for all ${d.members.length} jobs`);
    setGangView(d); seedGangEdits(d); seedGangMix(d); seedGangSheet(d); setGangWhOpen(false); load();
    // A parent that cannot stay on the new board — a copy of the OLD board's
    // sheet (SW-544 kept its old board's 22×28 after moving to 23×38, and
    // nobody was asked), or a size the new board cannot yield — follows the
    // board into the Run Sheet: filled, not saved. Lock sheet → asks whether it
    // goes to the Product Master or stays with these jobs.
    const lead = d.members?.[0];
    const carried = parentFollowsBoard({
      parent: { l: lead?.parent_l, w: lead?.parent_w },
      oldBoard: { l: before?.sheet_l, w: before?.sheet_w },
      newBoard: { l: lead?.sheet_l, w: lead?.sheet_w },
    });
    if (carried) {
      setGangSheetForm(f => ({ ...f, parent_l: String(carried.l), parent_w: String(carried.w) }));
      toast.info(`Parent ${lead.parent_l}×${lead.parent_w}" follows the new board — set to ${carried.l}×${carried.w}". Lock sheet → to save it.`);
    }
  };
```

- [ ] **Step 7: Lock sheet sends the parent (and accepts one-click values)**

Replace:

```js
  const lockGangSheet = () => {
    const anchor = gangView?.members?.[0];
    setGangSheetPrompt({
      gang_number: gangView.gang_number, count: gangView.members.length,
      job_card: gangView.job_card || null,
      payload: {
        board_material_id: anchor?.board_material_id,
        child_l: gangSheetForm.child_l, child_w: gangSheetForm.child_w, coating: gangSheetForm.coating,
      },
    });
  };
```

with:

```js
  // `over` lets the one-click "Use the board's full sheet" open this prompt
  // with the values it just filled — the form state it set is not readable
  // inside the same click.
  //
  // The parent is sent ONLY when the planner changed it — a coating-only lock
  // must not re-stamp the lead's parent onto every member — and never for a
  // co-printed run (its lock cuts on the board and never reads a parent). Both
  // fields blanked over a parent on file means "the board's full sheet", said
  // with the board's own dims: the route reads a blank as "no change".
  const lockGangSheet = (over = {}) => {
    const anchor = gangView?.members?.[0];
    const coPrinted = gangView.kind !== 'merge' && gangView.layout_mode === 'shared';
    const isBlank = v => v == null || v === '';
    const pl = over.parent_l ?? gangSheetForm.parent_l, pw = over.parent_w ?? gangSheetForm.parent_w;
    // Changed against what is on file: every member of a combined run (one
    // pile, one parent — an order added later can still carry its master's old
    // size), the lead of a gang (the Run Sheet shows the lead's).
    const differs = m => String(pl ?? '') !== String(m?.parent_l ?? '')
      || String(pw ?? '') !== String(m?.parent_w ?? '');
    const changed = gangView.kind === 'merge' ? (gangView.members || []).some(differs) : differs(anchor);
    // The one-click fix always says what it means, whatever the lead carries.
    const forced = over.parent_l != null && over.parent_w != null;
    // A half-typed parent is caught here, before the question is asked — the
    // route would only refuse it after Save. Input feedback, not a planning block.
    if (!coPrinted && (changed || forced) && isBlank(pl) !== isBlank(pw)) {
      toast.error('Parent size needs both length and width — or leave both blank for the board\'s full sheet');
      return;
    }
    const boardSized = +anchor?.sheet_l > 0 && +anchor?.sheet_w > 0;
    const parent = coPrinted || !(changed || forced) ? {}
      : isBlank(pl) && isBlank(pw)
        ? (boardSized ? { parent_l: String(anchor.sheet_l), parent_w: String(anchor.sheet_w) } : {})
        : { parent_l: pl, parent_w: pw };
    setGangSheetPrompt({
      gang_number: gangView.gang_number, count: gangView.members.length,
      job_card: gangView.job_card || null,
      payload: {
        board_material_id: anchor?.board_material_id,
        child_l: gangSheetForm.child_l, child_w: gangSheetForm.child_w, coating: gangSheetForm.coating,
        ...parent,
      },
    });
  };
```

Also find the button `onClick={lockGangSheet}` (the "Lock sheet →" button) and change it to
`onClick={() => lockGangSheet()}`, so React's click event is never passed in as `over`.

- [ ] **Step 8: The prompt names the parent**

In the `<Modal open={!!gangSheetPrompt} ...>` body, replace:

```jsx
              The board, child sheet &amp; coating apply to all <b>{gangSheetPrompt.count}</b> jobs in {gangSheetPrompt.gang_number}.
```

with:

```jsx
              The board, {gangSheetPrompt.payload.parent_l && gangSheetPrompt.payload.parent_w ? 'parent sheet, ' : ''}child sheet &amp; coating apply to all <b>{gangSheetPrompt.count}</b> jobs in {gangSheetPrompt.gang_number}.
```

and directly after the `Child sheet` row
(`<div className="flex items-center justify-between gap-3"><span className="font-semibold text-slate-700">Child sheet</span>...</div>`) add:

```jsx
              {gangSheetPrompt.payload.parent_l && gangSheetPrompt.payload.parent_w && (
                <div className="flex items-center justify-between gap-3"><span className="font-semibold text-slate-700">Parent sheet</span><span className="tabular-nums text-slate-500">{gangSheetPrompt.payload.parent_l}×{gangSheetPrompt.payload.parent_w}"</span></div>
              )}
```

- [ ] **Step 9: Run Sheet: parent fields, live preview, warning, one-click fix**

In the Run Sheet card, replace the block that begins
`{/* Child + coating — shared, with the live fit on the parent */}` and ends with the closing `})()}` of that IIFE
(it contains `const fit = clientFit(anchor?.sheet_l, ...)`, the three `Field`s, the fit line, the
`Lock sheet →` button and the source-of-truth paragraph) with:

```jsx
                  {/* Child + coating + parent — shared, with the live fit on the parent being typed */}
                  {(() => {
                    // A co-printed run cuts on the board's full sheet (its lock never
                    // reads a parent on file), so it shows no parent fields.
                    const coPrinted = gangView.kind !== 'merge' && gangView.layout_mode === 'shared';
                    const boardSheet = { sheet_l: anchor?.sheet_l, sheet_w: anchor?.sheet_w };
                    // The preview follows what is TYPED; the figures elsewhere on this
                    // screen follow the SAVED parent — the one the lock will use — until
                    // Lock sheet → saves the typed one.
                    const typed = coPrinted ? { l: +anchor?.sheet_l, w: +anchor?.sheet_w }
                      : cutParentOf({ parent_l: gangSheetForm.parent_l, parent_w: gangSheetForm.parent_w }, boardSheet);
                    const fit = clientFit(typed.l, typed.w, +gangSheetForm.child_l, +gangSheetForm.child_w);
                    // Changed against what is on file — every member of a combined run
                    // (one pile, one parent), the lead of a gang — the same test
                    // lockGangSheet sends by.
                    const formDiffers = m => String(gangSheetForm.parent_l ?? '') !== String(m?.parent_l ?? '')
                      || String(gangSheetForm.parent_w ?? '') !== String(m?.parent_w ?? '');
                    const parentDirty = !coPrinted && anchor
                      && (mergeMode ? gangView.members.some(formDiffers) : formDiffers(anchor));
                    const dirty = anchor && (parentDirty
                      || (gangSheetForm.child_l !== '' && +gangSheetForm.child_l !== +anchor.child_l)
                      || (gangSheetForm.child_w !== '' && +gangSheetForm.child_w !== +anchor.child_w)
                      || (gangSheetForm.coating || '') !== (anchor.coating || '')
                      || (anchor.board_name && anchor.master_board_name && anchor.board_name !== anchor.master_board_name)); // board changed vs master
                    // The SAVED parent of any member the lock will not take as the
                    // screen shows it: one that costs cuts on its board (the figures
                    // here use it), or one larger than its board (the figures fall back
                    // to the board, and the 14-Sep rule refuses the lock).
                    const flagged = coPrinted ? [] : gangView.members.map(m => {
                      const args = { parentL: m.parent_l, parentW: m.parent_w, boardL: m.sheet_l, boardW: m.sheet_w,
                                     childL: m.child_l, childW: m.child_w };
                      return { m, lossy: parentLosesCuts(args), tooBig: parentTooBig(args) };
                    }).filter(x => x.lossy || x.tooBig);
                    const useBoardSheet = () => {
                      if (!(+anchor?.sheet_l > 0 && +anchor?.sheet_w > 0)) {
                        toast.error('The run\'s board has no sheet size — set one board with a size for the whole run first');
                        return;
                      }
                      const over = { parent_l: String(anchor.sheet_l), parent_w: String(anchor.sheet_w) };
                      setGangSheetForm(f => ({ ...f, ...over }));
                      lockGangSheet(over);   // asks: Update Product Master / These jobs only
                    };
                    return (
                      <div className="mt-3 border-t border-slate-100 pt-3">
                        <div className={`mb-1.5 text-[10px] font-bold uppercase tracking-wide ${tv('text-violet-500', 'text-teal-600')}`}>Child (press sheet), coating &amp; parent — shared</div>
                        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                          <Field label="Child L (in)"><Input type="number" min="0" step="0.25" value={gangSheetForm.child_l} onChange={e => setGangSheetForm(f => ({ ...f, child_l: e.target.value }))} /></Field>
                          <Field label="Child W (in)"><Input type="number" min="0" step="0.25" value={gangSheetForm.child_w} onChange={e => setGangSheetForm(f => ({ ...f, child_w: e.target.value }))} /></Field>
                          <Field label="Coating"><SpecCombo id="gang-sheet-coat" value={gangSheetForm.coating} options={specOpts.coating} placeholder="e.g. Aqueous Varnish" onChange={e => setGangSheetForm(f => ({ ...f, coating: e.target.value }))} /></Field>
                          {!coPrinted && (
                            <>
                              <Field label="Parent L (in)" hint={anchor?.sheet_l ? `board ${anchor.sheet_l}"` : undefined}>
                                <Input type="number" min="0" step="0.25" value={gangSheetForm.parent_l}
                                  placeholder={anchor?.sheet_l ? String(anchor.sheet_l) : ''}
                                  onChange={e => setGangSheetForm(f => ({ ...f, parent_l: e.target.value }))} />
                              </Field>
                              <Field label="Parent W (in)" hint={anchor?.sheet_w ? `board ${anchor.sheet_w}"` : undefined}>
                                <Input type="number" min="0" step="0.25" value={gangSheetForm.parent_w}
                                  placeholder={anchor?.sheet_w ? String(anchor.sheet_w) : ''}
                                  onChange={e => setGangSheetForm(f => ({ ...f, parent_w: e.target.value }))} />
                              </Field>
                            </>
                          )}
                        </div>
                        {coPrinted && (
                          <p className="mt-1.5 text-[10px] text-slate-400">Co-printed runs cut on the board's full sheet.</p>
                        )}
                        {flagged.map(({ m, lossy, tooBig }) => (
                          <div key={m.id} className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-red-50 px-2.5 py-1.5">
                            <span className="text-[11px] font-semibold text-red-600">
                              <AlertTriangle size={12} className="mr-1 inline" />
                              {tooBig
                                ? <>{m.product_code}: parent on file {m.parent_l}×{m.parent_w}" is larger than the {m.sheet_l}×{m.sheet_w}" board — no guillotine can cut it, so Lock Run Plan will refuse until it changes.</>
                                : <>{m.product_code}: parent on file {lossy.declared.l}×{lossy.declared.w}" cuts {lossy.cuts_declared} per sheet —
                                  the {lossy.board.l}×{lossy.board.w}" board cuts {lossy.cuts_board}. The figures on this screen use {lossy.declared.l}×{lossy.declared.w}".</>}
                            </span>
                            <Button size="sm" variant="secondary" onClick={useBoardSheet}>Use the board's full sheet</Button>
                          </div>
                        ))}
                        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                          <span className="text-[11px] text-slate-500">
                            {fit && fit.cpp > 0
                              ? <>Child on parent: <b className="text-slate-800">{fit.cpp}/parent</b> · <span className={fit.waste <= 10 ? 'text-emerald-600' : fit.waste <= 20 ? 'text-amber-600' : 'text-red-600'}>{fit.util}% util</span></>
                              : <span className="font-semibold text-red-500">child doesn’t fit the parent — adjust</span>}
                          </span>
                          <Button size="sm" variant={dirty ? 'primary' : 'secondary'} disabled={!dirty} onClick={() => lockGangSheet()}>
                            <ShieldCheck size={13} /> Lock sheet →
                          </Button>
                        </div>
                        <p className="mt-2 text-[10px] leading-relaxed text-slate-400">
                          {mergeMode
                            ? <>Parent, child &amp; coating are the run's single source of truth — one carton, one layout, one pile end to end.</>
                            : <>Parent, child &amp; coating are the gang's single source of truth. Pasting, embossing &amp; other effects stay per product from each master — they run per carton after the split at die punching.</>}
                        </p>
                      </div>
                    );
                  })()}
```

(This replacement also covers Step 7's `onClick` change for the Lock sheet button. `AlertTriangle` is already
imported from `lucide-react` on line 13.)

- [ ] **Step 10: Run the pins and build the client**

Run: `cd server && node --test src/planning-parent-screen.test.js`
Expected: PASS, `# pass 7`, `# fail 0`.

Run: `cd .. && npm run build -w client`
Expected: `✓ built in …` with no errors.

- [ ] **Step 11: Run the whole server suite**

Run: `cd server && node --test src/*.test.js 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected: `# fail 0`. If a fixed-window pin fails only because its block moved, apply the rule at the top of
this plan.

- [ ] **Step 12: Do not commit.**


#### Task 6, review round 2 (after the quality review, 19 Sep 2026)

The review confirmed that the core works: before the lock, the screen and the lock count on one parent. It also found
four client problems, each fixed in this round:
- the Run Sheet was not re-seeded on the way back from a member;
- a typed oversize parent was previewed as the board;
- a false "parent follows" toast appeared on co-printed runs;
- the "changed" rule existed as two raw-string copies, which lit Lock sheet on a merge whose orders already cut
  the same sheet.

It also found one server gap, a stale saved draft, which is **Task 6b** below. The edits are made by
`task6v2/apply.py` in the session scratchpad. Every replacement in that script is asserted to be unique, and it
aborts before writing anything if one isn't. It carries the exact text of each edit:

1. **`client/src/lib/cutFit.js`**, appended: `runSheetParent`, the ONE rule for "did the parent change?" (the
   button's lit state) and "what does Lock sheet → send?". It compares effective sheets, so a half parent on file
   never blocks and co-printed runs never send a parent:
```js
// The Run Sheet's parent decision — ONE rule for whether the parent changed
// (it lights Lock sheet →) and for what Lock sheet → then sends, so the button
// and the payload can never disagree. (In review, 19 Sep 2026, two raw-string
// copies of this lit the button on a combined run whose orders already cut the
// same sheet.) Compared as EFFECTIVE sheets — what each member would actually
// cut on — so '23.0' and 38×23 are no change.
//   form      the Run Sheet fields { parent_l, parent_w } — strings, '' = blank
//   over      the one-click fill { parent_l, parent_w } (the board's own dims), or null
//   members   the run's members as MEMBER_VIEW sends them (parent_l/_w, sheet_l/_w)
//   isMerge   a combined run is one pile with one parent: every order is compared;
//             a gang compares its lead, whose values the Run Sheet shows
//   coPrinted a co-printed run's lock never reads a parent: none is ever sent
// Returns { changed, error, parent }. `parent` is spread into the Lock sheet
// payload ({} sends nothing; the route reads that as "no change"); `error` is
// said INSTEAD of asking — input feedback, never a planning block. A half
// parent already on file, untouched, never blocks an unrelated lock.
export function runSheetParent(args) {
  const { form, over, members, isMerge = false, coPrinted = false } = args ?? {};
  const none = { changed: false, error: null, parent: {} };
  const lead = members?.[0];
  if (coPrinted || !lead) return none;
  const boardOf = m => ({ sheet_l: m?.sheet_l, sheet_w: m?.sheet_w });
  const forced = over?.parent_l != null && over?.parent_w != null;
  const pl = forced ? over.parent_l : form?.parent_l;
  const pw = forced ? over.parent_w : form?.parent_w;
  const touched = forced || String(pl ?? '') !== String(lead.parent_l ?? '')
    || String(pw ?? '') !== String(lead.parent_w ?? '');
  if (touched && blank(pl) !== blank(pw))
    return { ...none, changed: true, error: 'Parent size needs both length and width — or leave both blank for the board\'s full sheet' };
  if (touched && ((!blank(pl) && !(+pl > 0)) || (!blank(pw) && !(+pw > 0))))
    return { ...none, changed: true, error: 'Parent size must be greater than zero' };
  // A half parent already on file means "no parent" to every cut: read it so.
  const halfOnFile = !touched && blank(pl) !== blank(pw);
  const ql = halfOnFile ? '' : pl, qw = halfOnFile ? '' : pw;
  // What a member would cut on under the typed parent, against what it cuts on
  // now — except a parent on file its board cannot yield: cutParentOf reads
  // that one as the board, so it is compared AS WRITTEN (the lock refuses it,
  // and blanking it must still send the board's sheet).
  const differs = m => (parentTooBig({ parentL: m?.parent_l, parentW: m?.parent_w, boardL: m?.sheet_l, boardW: m?.sheet_w })
    ? !sameSheet({ l: ql, w: qw }, { l: m.parent_l, w: m.parent_w })
    : !sameSheet(cutParentOf({ parent_l: ql, parent_w: qw }, boardOf(m)), cutParentOf(m, boardOf(m))));
  const tooBig = touched && parentTooBig({ parentL: ql, parentW: qw, boardL: lead.sheet_l, boardW: lead.sheet_w });
  const changed = forced || tooBig || (isMerge ? members.some(differs) : differs(lead));
  if (!changed) return none;
  if (blank(ql) && blank(qw)) {
    if (!(+lead.sheet_l > 0 && +lead.sheet_w > 0))
      return { ...none, changed: true, error: 'The run\'s board has no sheet size — set one board with a size for the whole run first' };
    return { changed: true, error: null, parent: { parent_l: String(lead.sheet_l), parent_w: String(lead.sheet_w) } };
  }
  return { changed: true, error: null, parent: { parent_l: ql, parent_w: qw } };
}
```
2. **`Planning.jsx`**: the import adds `runSheetParent`, and `returnToGang` calls `seedGangSheet(d)`.
3. **`setGangBoard`**: no carry on a co-printed run
   (`d.kind !== 'merge' && d.layout_mode === 'shared' ? null : parentFollowsBoard(…)`).
4. **`lockGangSheet(over = null)`**: asks `runSheetParent`. On an error it calls `toast.error` and asks nothing.
   The one-click (`over`) sends ONLY `{ ...d.parent }`, with no board, child or coating. The normal lock sends
   board, child and coating plus `...d.parent`.
5. **Prompt**:
   - Board row first; the Parent sheet row sits under it.
   - The Child sheet and Coating rows show only when sent.
   - The sentence says "Only the parent sheet below changes…" for a parent-only lock.
   - The "Parent (board)" label becomes "Board".
6. **Run Sheet**:
   - The header reads "Board" and "… board sheet".
   - `parentDirty = runSheetParent(…).changed`.
   - `typedTooBig` shows "Parent A×B is larger than the board…" in place of the fit preview.
   - Warning rows are deduped per product + parent + board, with an "(N orders)" count.
   - The oversize row names "Lock Run Plan" or "Lock Gang Plan" to match the kind.
   - `useBoardSheet` is renamed `fillBoardSheet`.

**Tests:**
- New `server/src/run-sheet-parent.test.js` (14 tests):
```js
// runSheetParent is the Run Sheet's ONE rule for "did the parent change?" (the
// lit Lock sheet → button) and "what does Lock sheet → send?" — so the two can
// never disagree, and the flows the review walked through (19 Sep 2026) are
// held here, where node --test can reach them, instead of only in Planning.jsx.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSheetParent } from '../../client/src/lib/cutFit.js';

// Members as MEMBER_VIEW sends them; the board is Duplex WB 350 23x38 (#399).
const m = (parent_l, parent_w, extra = {}) => ({ parent_l, parent_w, sheet_l: 23, sheet_w: 38, ...extra });
const form = (parent_l, parent_w) => ({ parent_l, parent_w });
const merge = args => runSheetParent({ isMerge: true, coPrinted: false, ...args });
const NONE = { changed: false, error: null, parent: {} };

test('CI-MRG-0028: the one-click sends the board\'s own sheet', () => {
  assert.deepEqual(merge({ form: form('22', '28'), over: { parent_l: '23', parent_w: '38' }, members: [m(22, 28), m(22, 28)] }),
    { changed: true, error: null, parent: { parent_l: '23', parent_w: '38' } });
});

test('untouched and agreeing: nothing lights, nothing is sent (a coating-only lock)', () => {
  assert.deepEqual(merge({ form: form('22', '28'), members: [m(22, 28), m(22, 28)] }), NONE);
});

test('a combined run whose orders already cut the same sheet does not light up', () => {
  // lead holds 23×38 as a job-only parent; a later order has no parent on the same 23×38 board
  assert.deepEqual(merge({ form: form('23', '38'), members: [m(23, 38), m(null, null)] }), NONE);
});

test('a later order still on an old parent lights up and gets the run\'s parent', () => {
  assert.deepEqual(merge({ form: form('23', '38'), members: [m(23, 38), m(22, 28)] }),
    { changed: true, error: null, parent: { parent_l: '23', parent_w: '38' } });
});

test('both fields blanked over a parent on file: the board\'s own sheet, said explicitly', () => {
  assert.deepEqual(merge({ form: form('', ''), members: [m(22, 28)] }).parent, { parent_l: '23', parent_w: '38' });
});

test('…unless the board has no size: said instead of asked', () => {
  const d = merge({ form: form('', ''), members: [m(22, 28, { sheet_l: null, sheet_w: null })] });
  assert.match(d.error, /no sheet size/);
  assert.deepEqual(d.parent, {});
});

test('a half-typed or non-positive parent is said instead of asked', () => {
  assert.match(merge({ form: form('22', ''), members: [m(22, 28)] }).error, /both length and width/);
  assert.match(merge({ form: form('0', '28'), members: [m(22, 28)] }).error, /greater than zero/);
});

test('a half parent ON FILE, untouched, never blocks an unrelated lock', () => {
  assert.deepEqual(merge({ form: form('22', ''), members: [m(22, null)] }), NONE);
});

test('a half parent on file with a disagreeing order: the board\'s sheet is sent, never half', () => {
  assert.deepEqual(merge({ form: form('22', ''), members: [m(22, null), m(22, 28)] }).parent, { parent_l: '23', parent_w: '38' });
});

test('a typed parent the board cannot yield is sent as typed (the lock refuses it; the screen says so)', () => {
  assert.deepEqual(merge({ form: form('32', '38'), members: [m(null, null)] }).parent, { parent_l: '32', parent_w: '38' });
});

test('the same sheet written differently is no change', () => {
  assert.equal(merge({ form: form('23.0', '38'), members: [m(23, 38)] }).changed, false);
  assert.equal(merge({ form: form('38', '23'), members: [m(23, 38)] }).changed, false);
});

test('a gang compares its lead only; a co-printed run never sends a parent', () => {
  assert.equal(runSheetParent({ form: form('23', '38'), members: [m(23, 38), m(22, 28)], isMerge: false }).changed, false);
  assert.deepEqual(runSheetParent({ form: form('23', '38'), members: [m(22, 28)], coPrinted: true }), NONE);
});

test('null arguments never throw', () => {
  assert.deepEqual(runSheetParent(null), NONE);
  assert.deepEqual(runSheetParent({ form: null, over: null, members: [] }), NONE);
});
test('a parent on file its board cannot yield is compared as written', () => {
  // blanking it sends the board's sheet (the lock would refuse the parent as it stands)
  assert.deepEqual(merge({ form: form('', ''), members: [m(32, 38)] }).parent, { parent_l: '23', parent_w: '38' });
  // a later order carrying one lights the button on a combined run
  assert.equal(merge({ form: form('23', '38'), members: [m(23, 38), m(32, 38)] }).changed, true);
  // untouched on the lead: nothing lights — the red row and its one-click speak for it
  assert.deepEqual(merge({ form: form('32', '38'), members: [m(32, 38)] }), NONE);
});
```
- `server/src/planning-parent-screen.test.js` is replaced by this version (8 pins):
```js
// Source pins for the planning screens: .jsx cannot be imported by node --test,
// so the RULES live in client/src/lib/cutFit.js (tested directly — see
// run-sheet-parent.test.js and parent-on-screen-client.test.js) and these pins
// hold the screens to calling them. CI-MRG-0028 is the reason: the run screen
// counted the board while the lock counted the parent on file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const P = readFileSync(new URL('../../client/src/pages/Planning.jsx', import.meta.url), 'utf8');
const between = (a, b) => { const i = P.indexOf(a); assert.ok(i >= 0, `missing: ${a}`); return P.slice(i, P.indexOf(b, i)); };

test('Planning imports the parent twins from cutFit.js', () => {
  assert.match(P, /import \{ clientStrips, chosenCutsValid, chosenStrips, cutParentOf, parentLosesCuts, parentFollowsBoard, parentTooBig, runSheetParent \} from '\.\.\/lib\/cutFit\.js';/);
});

test('gangCalc counts each member on the parent its lock cuts on', () => {
  const block = between('const gangCalc = useMemo', 'const position = useMemo');
  assert.match(block, /cutParentOf\(m, board\)/);
  assert.doesNotMatch(block, /clientFit\(anchor\?\.sheet_l, anchor\?\.sheet_w, \+m\.child_l/);
});

test('the Run Sheet form holds the parent, seeded from the saved one — also on the way back from a member', () => {
  assert.match(P, /useState\(\{ child_l: '', child_w: '', coating: '', parent_l: '', parent_w: '' \}\)/);
  assert.match(between('const seedGangSheet', 'const seedGangNumbers'), /parent_l: d\.members\?\.\[0\]\?\.parent_l != null/);
  assert.match(between('const returnToGang', 'const dismissEngine'), /seedGangSheet\(d\)/);
});

test('Lock sheet and the button\'s lit state ask ONE rule; the one-click sends the parent only', () => {
  const block = between('const lockGangSheet', 'const applyGangSheet');
  assert.match(block, /runSheetParent\(\{/);
  assert.match(block, /if \(d\.error\) \{ toast\.error\(d\.error\); return; \}/);
  assert.match(block, /payload: over\s*\? \{ \.\.\.d\.parent \}/);
  assert.match(P, /const parentDirty = runSheetParent\(\{ form: gangSheetForm, members: gangView\.members, isMerge: mergeMode, coPrinted \}\)\.changed;/);
  assert.match(P, /<span className="font-semibold text-slate-700">Parent sheet<\/span>/);
});

test('the Run Sheet warns once per product when the saved parent costs cuts or is larger than its board, with the one-click fix', () => {
  const sheet = between('const flagged = coPrinted', 'Lock sheet →');
  assert.match(sheet, /parentLosesCuts\(args\)/);
  assert.match(sheet, /parentTooBig\(args\)/);
  assert.match(sheet, /orders: acc\[k\]\.orders \+ 1/);
  assert.match(sheet, /is larger than the/);
  assert.match(sheet, /Use the board's full sheet/);
});

test('a typed parent the board cannot yield is said in the preview, not previewed as the board', () => {
  assert.match(P, /const typedTooBig = !coPrinted && parentTooBig\(\{ parentL: gangSheetForm\.parent_l, parentW: gangSheetForm\.parent_w,/);
});

test('a run board change carries a parent that cannot stay — never on a co-printed run', () => {
  const block = between('const setGangBoard', 'const lockGangSheet');
  assert.match(block, /parentFollowsBoard\(/);
  assert.match(block, /d\.kind !== 'merge' && d\.layout_mode === 'shared' \? null/);
});

test('the one-click needs a sized board', () => {
  assert.match(between('const fillBoardSheet', 'lockGangSheet(over)'), /if \(!\(\+anchor\?\.sheet_l > 0 && \+anchor\?\.sheet_w > 0\)\)/);
});
```

Verify: `cd server && node --test src/run-sheet-parent.test.js src/planning-parent-screen.test.js` gives 22 pass.
`npm run build -w client` must build.

---

#### Task 6, review round 3 (after the quality re-review, 19 Sep 2026)

Two regressions from round 2, both fixed in `runSheetParent` so node --test can hold them:
- **An unsized board never blocks an unrelated lock.** Two unsized cuts compare as the same cut (`sameCut`). The
  "board has no sheet size" error is said only when the planner actually touched the parent; otherwise nothing
  is sent and the lock goes ahead. Round 2 blocked a coating-only Lock sheet on such a run: a new blocker,
  against contract rule 1.
- **The one-click never stamps one board's sheet across boards of different sizes.** When the orders' boards
  differ in size, the parent-only fill says to pick one board first. Round 2 sent the lead's sheet to an order
  on a smaller board, and "Update Product Masters" would have written that impossible size into its master.
  Boards are compared by size, not id.

Minors, same round:
- A merge whose LEAD holds the flagged parent no longer lights Lock sheet on its own, so an unrelated lock
  cannot spread the fossil onto orders already fixed. The red row and its one-click speak for it.
- The parent-only prompt labels the board "Board (unchanged)".
- The typed-oversize preview and the prompt say the lock will refuse it.
- The co-printed section header drops "parent".

### Task 6b: A saved draft follows a sheet change (server)

**Why (quality review of Task 6):**
- `reDeriveMemberSheets` returns early for `pending` lines.
- A saved draft is a set of pending lines with `parent_sheets_required` stored.
- `memberParentSheets` returns that stored figure first.
- So after Lock sheet, or the one-click fix, on a DRAFT run, To Issue moves to the new parent. But `needed_gross`,
  the Short verdict and the Raise PR quantity stay on the old one: the CI-MRG-0028 contradiction the other way
  round.

**Files:**
- Modify: `server/src/routes/gangs.js`, `reDeriveMemberSheets`
- Test: `server/src/draft-follows-sheet.test.js` (create)

- [ ] **Step 1: Write the failing test.** Create `server/src/draft-follows-sheet.test.js`:
```js
// A saved draft (pending lines with figures stored — LINE_VIEW's plan_draft)
// is a cut plan too. reDeriveMemberSheets skipped it, so a sheet change on a
// draft run left the server's figures (Board Position, Short, Raise PR) on the
// old parent while the screen counted the new one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const GANGS = readFileSync(new URL('./routes/gangs.js', import.meta.url), 'utf8');
const start = GANGS.indexOf('async function reDeriveMemberSheets');
const fn = GANGS.slice(start, GANGS.indexOf('\n}\n', start));

test('a saved draft is re-derived like a planned line', () => {
  assert.match(fn, /const isDraft = l => l\.status === 'pending' && l\.parent_sheets_required != null;/);
  assert.match(fn, /if \(!editable\.includes\(line\.status\) && !isDraft\(line\)\) return;/);
});

test('a co-printed run re-splits its drafts too', () => {
  assert.match(fn, /if \(!\['planned', 'ready'\]\.includes\(lines\[i\]\.status\) && !isDraft\(lines\[i\]\)\) continue;/);
});
```
- [ ] **Step 2:** `cd server && node --test src/draft-follows-sheet.test.js`: both tests FAIL.
- [ ] **Step 3: Implementation.** In `reDeriveMemberSheets`, replace:
```js
  const editable = live ? ['planned', 'ready', 'in_production'] : ['planned', 'ready'];
  if (!editable.includes(line.status)) return;
```
with:
```js
  const editable = live ? ['planned', 'ready', 'in_production'] : ['planned', 'ready'];
  // A saved draft (pending, figures stored — LINE_VIEW's plan_draft) is a cut
  // plan too: left on the old sheet, the run's Board Position, Short and Raise
  // PR quote its stale figure while the screen counts the new one.
  const isDraft = l => l.status === 'pending' && l.parent_sheets_required != null;
  if (!editable.includes(line.status) && !isDraft(line)) return;
```
   and, in the co-printed branch, replace
   `        if (!['planned', 'ready'].includes(lines[i].status)) continue;`
   with
   `        if (!['planned', 'ready'].includes(lines[i].status) && !isDraft(lines[i])) continue;`
- [ ] **Step 4:** Run the new test (2 pass) plus `src/run-leftover-wiring.test.js`. That file's fixed-window pins on
  `reDeriveMemberSheets` (6000 and 7000 characters) may need widening under the plan's rule.
- [ ] **Step 5:** Full suite: 0 fail. Do not commit.

---

#### Task 6b, review round 2 (after the quality review, 19 Sep 2026)

**A regression 6b created.** `reDeriveMemberSheets` clears the member's board mix and sweeps the banked strip, and
its three callers ran it even when nothing it derives from changed:
- `/shared` re-derived every member on every Lock sheet. The UI always sends board, child and coating, so a
  coating-only change re-derived the lot.
- `/board` re-derived on a re-pick of the board the run already had.
- PATCH lines re-derived on a coating, colour or emboss edit.

Planned lines already paid for this. With 6b a saved DRAFT paid too: its half-built mix, which draft Save
deliberately protects, vanished on a coating change.

**Fix: `cutPlanInputs(master, line)` (helpers.js).** It is a key over the effective board, child, parent and ups,
plus the line's net quantity and wastage. Every caller re-derives only when that key changed:
- `/shared` and `/board` snapshot every member in a pre-pass and compare in a post-pass. With update_master, a
  merge's second order of the same product reads the already-updated master mid-loop.
- PATCH lines compares the key before and after its edit.

**Also:**
- the co-printed branch now sweeps the run's banked strip (it returned before the sweep);
- `reDeriveMemberSheets` returns the mix rows cleared, and the routes answer `mix_cleared` so the Run Sheet can
  say it (client toast after Task 7);
- the header comments are corrected;
- behavioural tests drive the real function with stub `qc`/`oc`.

**Follow-ups found in this review, not in this branch:**
- FG consume/release re-derive on the bare board and drop wastage (`fg.js` ~319, `helpers.js` ~2208); fixing
  that needs the co-printed exception;
- a board freeze is not re-held after a re-derive;
- the issue override is dropped from re-derived figures;
- `unbankRunLeftover` audits zero batches, one line per member.

#### Task 6b, review round 3 (19 Sep 2026): the gate is a request pre-check, not a per-member key

**Round 2's `cutPlanInputs` gate was wrong for co-printed runs.** It keyed the EFFECTIVE child, but a co-printed
run reads its child from the job OVERRIDES only (`sharedLayoutState`). So a layout going from pending to settled
at the master's own size looked unchanged.
- Step 1: Lock sheet with "Update Product Master" drops every child override, and the layout goes pending
  (pre-existing).
- Step 2: "these jobs only" at the same size stamps them again, and nothing re-derived.
- The stale figure reaches the job card through `readiness()`. Round 1 healed at step 2.
- Its post-pass also re-split a co-printed run once per member.

**Replacement: `requestChangesCut({ gang, lines, masters, patch })` (helpers.js).** It runs BEFORE any write and
asks whether the request changes any member's cut AS `reDeriveMemberSheets` READS IT:
- a co-printed child is compared against the override; a co-printed parent is ignored;
- everything else is compared against override-over-master.

When it says yes, each route re-derives in the loop exactly as round 1 did, which restores the single re-split per
request. PATCH lines also re-derives on a qty change.

**Also:**
- `mix_cleared` becomes a boolean. Member-level row counts mislead on runs, whose rows are split across members.
- `unbankRunLeftover` skips batches that are already dead, so there is no empty audit line on every later
  re-derive.
- The comments are corrected.

**Follow-up (pre-existing):** a shared layout should keep its explicit child under update_master. Today the primary
button un-settles the layout.

### Task 7: Single engine: warning under Parent L/W, one-click fix, board carry

**Amended 19 Sep 2026 (controller, before dispatch):** the carry must run on EVERY board change in the single
engine, not only `pickBoard`. Otherwise pick → carry → **Undo** puts the old board back with the carried parent,
a size the old board cannot yield, and plan-save refuses it (the 14-Sep rule): a trap this change would create.
So `pickBoard`, `undoBoard` and `resetBoard` share one `carryParent` helper. `resetBoard` learns the master board's
dims only after `loadCtx`, so it carries after the await. Out of scope, listed as follow-ups:
- `confirmMixMakeMaster`: a full-replacement mix made the product's board saves at once; the Cut Plan warning
  shows a stale parent on the next plan.
- `applyGangBoard`: the gang's other members show the Run Sheet warning.

**Files:**
- Modify: `client/src/pages/Planning.jsx`: `carryParent` + `followNote` (new, directly above `pickBoard`),
  `pickBoard`, `undoBoard`, `resetBoard`, and the Cut Plan card
- Test: `server/src/planning-parent-screen.test.js` (append 2), `server/src/parent-on-screen-client.test.js`
  (append 1)

- [ ] **Step 1: Write the failing tests**

Append to `server/src/planning-parent-screen.test.js`:

```js
test('single engine: every board change carries a parent that cannot stay on the new board', () => {
  assert.match(between('const carryParent', 'const pickBoard'), /parentFollowsBoard\(/);
  assert.match(between('const pickBoard = async row', '// ── Commit / uncommit'), /carryParent\(boardSel, next\)/);
  assert.match(between('const undoBoard = async', 'const resetBoard = async'), /carryParent\(boardSel, prev\)/);
  assert.match(between('const resetBoard = async', 'Board reset to the product master'), /carryParent\(from, board\)/);
});

test('single engine: the Cut Plan warns under Parent L/W and offers the board\'s full sheet', () => {
  assert.match(P, /parentLosesCuts\(\{ parentL: form\.parent_l, parentW: form\.parent_w/);
  const warn = between('parentLosesCuts({ parentL: form.parent_l', '</Card>');
  assert.match(warn, /parent_l: String\(boardSel\.sheet_l\), parent_w: String\(boardSel\.sheet_w\)/);
  assert.match(warn, /Use the board's full sheet/);
});
```

Append to `server/src/parent-on-screen-client.test.js` (it pins the property Undo relies on, so it passes at once;
that is expected, it is a characterisation test of the Task 1 rule, not new code):

```js
test('parentFollowsBoard: a pick that carried, undone, carries back; a trim that fits both stays both ways', () => {
  const A = { l: 22, w: 28 }, B = { l: 23, w: 38 };
  const picked = parentFollowsBoard({ parent: { l: '22', w: '28' }, oldBoard: A, newBoard: B });
  assert.deepEqual(picked, B);
  assert.deepEqual(parentFollowsBoard({ parent: { l: String(picked.l), w: String(picked.w) }, oldBoard: B, newBoard: A }), A);
  assert.equal(parentFollowsBoard({ parent: { l: '20', w: '28' }, oldBoard: A, newBoard: B }), null);
  assert.equal(parentFollowsBoard({ parent: { l: '20', w: '28' }, oldBoard: B, newBoard: A }), null);
});
```

- [ ] **Step 2: Run the tests to verify**

Run: `cd server && node --test src/planning-parent-screen.test.js src/parent-on-screen-client.test.js`
Expected: the 2 new planning-parent-screen tests FAIL (`missing: const carryParent` and
`missing: parentLosesCuts({ parentL: form.parent_l`); the 10 from Task 6 (8 + round 3's prompt pin + round 4's fill pin) pass;
parent-on-screen-client passes 14.

- [ ] **Step 3: One carry for every board change**

Directly above `const pickBoard = async row => {` (below its comment block), add:

```js
  // A board change (a pick, an Undo, a Reset) carries a parent that cannot
  // stay on the new board: a copy of the OLD board's sheet, or a size the new
  // board cannot yield (spec §4). It lands in the fields, visible before Lock,
  // and the Lock's master question carries it (Update Product Master / This
  // job only). A genuine trim that still fits stays put; the Cut Plan warns
  // if it costs cuts. Undo and Reset carry too: a pick that carried and was
  // then undone would otherwise leave a parent the old board cannot yield.
  const carryParent = (fromBoard, toBoard) => {
    const carried = parentFollowsBoard({
      parent: { l: form.parent_l, w: form.parent_w },
      oldBoard: { l: fromBoard?.sheet_l, w: fromBoard?.sheet_w },
      newBoard: { l: toBoard?.sheet_l, w: toBoard?.sheet_w },
    });
    if (carried) setForm(f => ({ ...f, parent_l: String(carried.l), parent_w: String(carried.w) }));
    return carried;
  };
  const followNote = c => (c ? ` · parent follows it: ${c.l}×${c.w}"` : '');
```

Replace `pickBoard`:

```js
  const pickBoard = async row => {
    const next = { id: row.id ?? row.material_id, name: row.name, sheet_l: row.sheet_l, sheet_w: row.sheet_w };
    setBoardHist(h => [...h, boardSel]);
    setLo({ push: false, strip: null }); // a different board leaves different strips
    setBoardSel(next); setWhOpen(false); setCtx(null);
    setCtx(await loadCtx(planLine, next.id));
    toast.info(`Board switched to ${next.name} for this plan — lock to confirm`);
  };
```

with:

```js
  const pickBoard = async row => {
    const next = { id: row.id ?? row.material_id, name: row.name, sheet_l: row.sheet_l, sheet_w: row.sheet_w };
    const carried = carryParent(boardSel, next);
    setBoardHist(h => [...h, boardSel]);
    setLo({ push: false, strip: null }); // a different board leaves different strips
    setBoardSel(next); setWhOpen(false); setCtx(null);
    setCtx(await loadCtx(planLine, next.id));
    toast.info(`Board switched to ${next.name} for this plan — lock to confirm${followNote(carried)}`);
  };
```

In `undoBoard`: directly after `if (!prev) return;` add `const carried = carryParent(boardSel, prev);`, and change
its toast to `` toast.info(`Board back to ${prev.name}${followNote(carried)}`); ``.

In `resetBoard`: make `const from = boardSel;` its first line, and replace

```js
    const fresh = await loadCtx(planLine, master.id);
    setBoardSel({ id: fresh.board.id, name: fresh.board.name, sheet_l: fresh.board.sheet_l, sheet_w: fresh.board.sheet_w });
    setCtx(fresh);
    toast.info('Board reset to the product master');
```

with

```js
    const fresh = await loadCtx(planLine, master.id);
    // The master board's own dims arrive only now (the line row carries the
    // effective board's), so the parent carries here, after the reload.
    const board = { id: fresh.board.id, name: fresh.board.name, sheet_l: fresh.board.sheet_l, sheet_w: fresh.board.sheet_w };
    const carried = carryParent(from, board);
    setBoardSel(board);
    setCtx(fresh);
    toast.info(`Board reset to the product master${followNote(carried)}`);
```

- [ ] **Step 4: The Cut Plan warning with the one-click fix**

In the Cut Plan card (`<Card icon={Scissors} title="Cut Plan" ...>`), find the closing `</div>` of the
`grid grid-cols-2 gap-3 sm:grid-cols-4` field grid, directly followed by:

```jsx
                  {calc && (
                    <div className="mt-3 grid grid-cols-3 gap-2">
```

Insert between them:

```jsx
                  {/* The parent this plan cuts on costs cuts against its own board —
                      said out loud, never blocked (a deliberate trim is the
                      planner's call). One click puts the board's full sheet in the
                      fields; the Lock's master question then asks where it goes. */}
                  {calc && boardSel && (() => {
                    const lossy = parentLosesCuts({ parentL: form.parent_l, parentW: form.parent_w,
                      boardL: boardSel.sheet_l, boardW: boardSel.sheet_w, childL: calc.childL, childW: calc.childW });
                    return lossy && (
                      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-red-50 px-2.5 py-1.5">
                        <span className="text-[11px] font-semibold text-red-600">
                          <AlertTriangle size={12} className="mr-1 inline" />
                          Parent {lossy.declared.l}×{lossy.declared.w}" cuts {lossy.cuts_declared} per sheet —
                          the {lossy.board.l}×{lossy.board.w}" board cuts {lossy.cuts_board}. This plan uses {lossy.declared.l}×{lossy.declared.w}".
                        </span>
                        <Button size="sm" variant="secondary"
                          onClick={() => setForm(f => ({ ...f, parent_l: String(boardSel.sheet_l), parent_w: String(boardSel.sheet_w) }))}>
                          Use the board's full sheet
                        </Button>
                      </div>
                    );
                  })()}
```

- [ ] **Step 5: Run the pins and build**

Run: `cd server && node --test src/planning-parent-screen.test.js src/parent-on-screen-client.test.js`
Expected: PASS, `# pass 26` (12 + 14), `# fail 0`.

Run: `cd .. && npm run build -w client`
Expected: built, no errors.

- [ ] **Step 6: Full suite** `cd server && node --test src/*.test.js 2>&1 | grep -E "^# (tests|pass|fail)"`: 0 fail,
  3184 tests (3181 after Task 6 round 4, plus these 3). Do not commit.

---

#### Task 7, review round 2 (after the quality review, 19 Sep 2026): the single engine must know the REAL board

**What the review found (verified by the controller).** `LINE_VIEW` builds `sheet_l/sheet_w` as
`COALESCE(override.parent_l, p.parent_l, bm.sheet_l)`, the FOLDED parent (orders.js ~136), and `openPlan` seeds
`boardSel` from them. The context route's same-board branch hands back the same folded values (orders.js ~2369),
and `resetBoard` reads those. So until a pick, the single engine's "board" IS the saved parent. As a result:
- **(a)** the Cut Plan warning compares the parent with itself and never fires on a saved lossy parent. SW-544
  opened solo shows no warning, and GAL-001, GAL-072 and SW-586 would not warn either;
- **(b)** the one-click can write the fossil back;
- **(c)** every pick "carries" a genuine trim away, because every saved parent looks like a copy of the old board.
  SW-258 has 22×28 on a 26×30 board;
- **(d)** Undo can reinstate the fossil;
- the older symptoms: "Sheet (in)" shows the parent, and typing the real board's size raises a false "larger than
  board" pill.

Plan-save measures against the real `materials` row. The run engine is unaffected: MEMBER_VIEW reads `bm.sheet_l`.

**Design:**
- **S1: `LINE_VIEW` exposes the board's own sheet.** Add `bm.sheet_l AS board_sheet_l, bm.sheet_w AS board_sheet_w`,
  with a comment that `sheet_l/_w` stay the folded parent (what the plan cuts on) and that these are the board's
  own sheet.
- **S2: the context route's same-board branch returns the real sheet:**
  `{ id: matId, name: line.board_name, sheet_l: line.board_sheet_l, sheet_w: line.board_sheet_w }`. The other branch
  already reads `materials`. The mix block's "planned" board further down keeps `line.sheet_l`, deliberately: it
  is measured on the parent the plan cuts on.
- **L1: `engineParent({ form, saved, board })` in cutFit.js** mirrors the server exactly.
  - Per axis, take the typed value if not blank, else the saved one. Saved is LINE_VIEW's per-axis
    `COALESCE(override, master)`.
  - `declared` is that pair when both axes are present and > 0, else null.
  - `parent` is `declared ?? board`.
  - Returns `{ declared, parent }`.
  - This is the server's per-axis COALESCE plus `effectiveParent`'s "both or the board". A blank field means "no
    change" to plan-save (`changedSpec` skips blanks), so blank falls back to the SAVED parent, never the board.
- **L2: `boardSheetFill({ saved, board })`** is what "the board's full sheet" means in the fields:
  - the board's dims as strings when a parent is on file, both axes (a blank can't clear a saved parent);
  - BLANKS when nothing is on file. Blank is the saved state: no edit, no master question, and nothing new that
    could turn into a fossil after a later board change.
- **L3: `boardSwitch({ form, saved, from, to })`** returns `{ fill, carried, declared }`. `declared` comes from
  `engineParent` on the `from` board; `carried = parentFollowsBoard({ parent: declared, oldBoard: from, newBoard: to })`;
  `fill = carried ? boardSheetFill({ saved, board: to }) : null`.
- **L4: `boardUndo({ form, entry })`.** Each `boardHist` entry is `{ board, parentBefore: { parent_l, parent_w }, fill }`.
  - If the switch filled the fields and they still hold exactly that fill, restore `parentBefore`.
  - Otherwise return null and leave the fields alone.
  - Undo restores what the switch changed; it never re-derives.
  - This covers the review's I1 cases: typed 22×36 → a pick carries it → Undo gives 22×36 back; a pick that didn't
    carry → Undo leaves the typed 22×28 alone.
- **P1: `openPlan`** seeds `boardSel` with `sheet_l: l.board_sheet_l ?? l.sheet_l` (and the same for `_w`). MEMBER_VIEW
  rows (`openPlan(m)` from a run) carry the real `sheet_l` and no `board_sheet_l`, so the fallback is right for them.
- **P2: `calc`** takes `parentL/W` from `engineParent`, and exposes `calc.declared`.
  - `parentTrimmed` is `declared && !sameSheet(declared, board)`.
  - `parentOversize` is `declared && parentTooBig(declared vs board)`.
  - This also fixes the M6 half-typed mismatch.
- **P3: the Cut Plan warning** takes `parentLosesCuts` on `calc.declared` against the real `boardSel`. The one-click
  sets `boardSheetFill({ saved, board: boardSel })`.
- **P4: `carryParent`** becomes `boardSwitch` plus a `setForm` of `fill`.
  - `pickBoard`, `resetBoard` and Undo push and pop `{ board, parentBefore, fill }` entries.
  - Every consumer of `boardHist` reads `entry.board`: the Undo title, and the resets in `openPlan` and
    `applyGangBoard`.
  - `resetBoard` decides with a `formRef` (useRef updated every render). Its carry runs after an await, and the
    fields stay editable meanwhile (M1).
  - Its placeholder board uses `boardMasterFor(id)` dims when known, else null, never the line's folded dims (part
    of M2).
- **P5: the toast** names both sides (M4): `· parent 22×28" → 23×38"`, or `→ the board's full sheet` when the fill
  is blank.
- **P6: the master prompt ties `parent_l` and `parent_w`** (M5). Ticking or unticking one does the same to the other
  when both changed, so a mixed parent can never be written to a master.
- **P7: correct the two wrong comments** (M3).

**Not in this round (follow-ups):**
- M2's full `boardSeq` sequencing of the board handlers;
- M7's nits;
- `confirmMixMakeMaster` and `applyGangBoard` carries;
- the Run Sheet's one-click on a merge writing board dims into an order whose product has NO parent on file. Same
  shape as I2; it needs "clear" plumbing in `/shared`, and that is Anik's call.

**Tests:**
- Unit tests for `engineParent`, `boardSheetFill`, `boardSwitch` and `boardUndo` in a new
  `server/src/single-engine-parent.test.js`. Cover:
  - SW-544's row (saved 22×28, board 23×38) → declared 22×28 and `parentLosesCuts` 1 vs 3;
  - a blank form + saved → the saved parent, NOT the board;
  - half typed + nothing saved → the board;
  - typed L + saved W → mixed, as the server does;
  - SW-258 (22×28 on 26×30) picking another 26×30 → no carry;
  - a copy of the old board with a saved parent → fill = the new board's dims, and with nothing saved → blanks;
  - the I1 sequences;
  - pick → carry → edit → Undo leaves the edit.
- Server pins: LINE_VIEW has `bm.sheet_l AS board_sheet_l`, and the context route's same-board branch uses
  `line.board_sheet_l`.
- Planning.jsx pins: `openPlan` seeds from `board_sheet_l`, `calc` calls `engineParent`, `carryParent` calls
  `boardSwitch`, Undo calls `boardUndo`, the one-click calls `boardSheetFill`, and the warning reads
  `calc.declared`. Rewrite Task 7's two pins to the new shapes. The characterisation test stays.
- Full suite 0 fail; the client builds; do not commit.

---

### Task 8: `check:parent`: effective parent in CHECK 1, CHECK 3 informational

**Files:**
- Modify: `scripts/check-parent-fit.mjs`
- Test: `server/src/check-parent-fit-lossy.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `server/src/check-parent-fit-lossy.test.js`:

```js
// check:parent is the standing net under the parent rules. CHECK 1 (a locked
// plan priced in child sheets) must measure the parent the lock used — the
// EFFECTIVE one, job override included. CHECK 3 lists parents that cost cuts
// (CI-MRG-0028's shape) for a human to judge, and must never fail the run:
// a deliberate trim is allowed (no hard blockers — Anik, 19 Sep 2026).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const S = readFileSync(new URL('../../scripts/check-parent-fit.mjs', import.meta.url), 'utf8');

test('CHECK 1 reads the effective parent, not the master\'s alone', () => {
  const locked = S.slice(S.indexOf('const LOCKED_LINES'), S.indexOf('ORDER BY ol.id`;', S.indexOf('const LOCKED_LINES')));
  assert.match(locked, /COALESCE\(\(ol\.spec_override->>'parent_l'\)::float, p\.parent_l\) AS parent_l/);
  assert.doesNotMatch(locked, /p\.name AS product, p\.parent_l, p\.parent_w,/);
});

test('CHECK 1 counts a co-printed run on the board, the sheet its lock used', () => {
  const locked = S.slice(S.indexOf('const LOCKED_LINES'), S.indexOf('ORDER BY ol.id`;', S.indexOf('const LOCKED_LINES')));
  assert.match(locked, /gr\.layout_mode,/);
  assert.match(S, /const coPrinted = r\.layout_mode === 'shared' && r\.run_kind !== 'merge';/);
  assert.match(S, /parent_l: coPrinted \? null : r\.parent_l, parent_w: coPrinted \? null : r\.parent_w,/);
});

test('CHECK 3 lists parents that cost cuts through the server rule', () => {
  assert.match(S, /import \{ childFit, cuttingParent, parentSheetsRequired, parentLosesCuts \} from '\.\.\/server\/src\/helpers\.js';/);
  assert.match(S, /── CHECK 3 — a parent on file that costs cuts/);
});

test('CHECK 3 never changes the exit code', () => {
  const exit = S.slice(S.lastIndexOf('process.exit('));
  assert.doesNotMatch(exit, /lossy/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && node --test src/check-parent-fit-lossy.test.js`
Expected: the first 3 tests FAIL; the last one passes (and must stay passing).

- [ ] **Step 3: Implement**

In `scripts/check-parent-fit.mjs`, replace:

```js
import { childFit, cuttingParent, parentSheetsRequired } from '../server/src/helpers.js';
```

with:

```js
import { childFit, cuttingParent, parentSheetsRequired, parentLosesCuts } from '../server/src/helpers.js';
```

In `LOCKED_LINES`, replace:

```sql
         p.code, p.name AS product, p.parent_l, p.parent_w,
```

with:

```sql
         p.code, p.name AS product,
         COALESCE((ol.spec_override->>'parent_l')::float, p.parent_l) AS parent_l,
         COALESCE((ol.spec_override->>'parent_w')::float, p.parent_w) AS parent_w,
```

Also in `LOCKED_LINES`, replace:

```sql
         gr.gang_number, gr.kind AS run_kind, gr.issue_parent_sheets, o.po_number,
```

with:

```sql
         gr.gang_number, gr.kind AS run_kind, gr.layout_mode, gr.issue_parent_sheets, o.po_number,
```

In the CHECK 1 loop, replace:

```js
  const product = { parent_l: r.parent_l, parent_w: r.parent_w, child_l: r.child_l, child_w: r.child_w };
```

with:

```js
  // The parent its lock used: a co-printed run's lock cuts on the board's own
  // sheet and never reads the parent on file (gangs.js shared arm).
  const coPrinted = r.layout_mode === 'shared' && r.run_kind !== 'merge';
  const product = { parent_l: coPrinted ? null : r.parent_l, parent_w: coPrinted ? null : r.parent_w,
                    child_l: r.child_l, child_w: r.child_w };
```

Directly after the `const ARMED_PAIRS = \`...\`;` statement, add:

```js
// CHECK 3's rows: every non-closed line and every active master that carries a
// parent on file. parentLosesCuts (the server rule the planning screens' twin
// is pinned to) decides which of them cost cuts.
const OPEN_WITH_PARENT = `
  SELECT ol.id, ol.status, ol.sheets_required, ol.parent_sheets_required,
         p.code,
         COALESCE((ol.spec_override->>'parent_l')::float, p.parent_l) AS parent_l,
         COALESCE((ol.spec_override->>'parent_w')::float, p.parent_w) AS parent_w,
         (ol.spec_override->>'parent_l') IS NOT NULL AS parent_is_job_override,
         COALESCE((ol.spec_override->>'child_l')::float, p.child_l) AS child_l,
         COALESCE((ol.spec_override->>'child_w')::float, p.child_w) AS child_w,
         m.name AS board, m.sheet_l AS board_l, m.sheet_w AS board_w,
         gr.gang_number, COALESCE(gr.layout_mode = 'shared' AND gr.kind <> 'merge', false) AS co_printed
  FROM order_lines ol
  JOIN products p ON p.id = ol.product_id
  JOIN materials m ON m.id = COALESCE((ol.spec_override->>'board_material_id')::int, p.board_material_id)
  LEFT JOIN gang_runs gr ON gr.id = ol.gang_run_id
  WHERE ol.status IN ('pending','planned','ready','in_production')
    AND COALESCE((ol.spec_override->>'parent_l')::float, p.parent_l) IS NOT NULL
    AND COALESCE((ol.spec_override->>'parent_w')::float, p.parent_w) IS NOT NULL
  ORDER BY ol.id`;
const MASTERS_WITH_PARENT = `
  SELECT p.code, p.parent_l, p.parent_w, p.child_l, p.child_w,
         m.name AS board, m.sheet_l AS board_l, m.sheet_w AS board_w
  FROM products p JOIN materials m ON m.id = p.board_material_id
  WHERE p.active = 1 AND p.parent_l IS NOT NULL AND p.parent_w IS NOT NULL
  ORDER BY p.code`;
```

Replace:

```js
const locked = (await c.query(LOCKED_LINES)).rows;
const armed = (await c.query(ARMED_PAIRS)).rows;
await c.end();
```

with:

```js
const locked = (await c.query(LOCKED_LINES)).rows;
const armed = (await c.query(ARMED_PAIRS)).rows;
const openWithParent = (await c.query(OPEN_WITH_PARENT)).rows;
const mastersWithParent = (await c.query(MASTERS_WITH_PARENT)).rows;
await c.end();

const losesOn = r => parentLosesCuts(
  { parent_l: r.parent_l, parent_w: r.parent_w, child_l: r.child_l, child_w: r.child_w },
  { sheet_l: r.board_l, sheet_w: r.board_w });
const lossyLines = openWithParent.map(r => ({ r, v: losesOn(r) })).filter(x => x.v);
const lossyMasters = mastersWithParent.map(r => ({ r, v: losesOn(r) })).filter(x => x.v);
```

Directly BEFORE the final block that begins `if (!wrong.length && !armed.length) {`, add:

```js
// ── CHECK 3 — a parent on file that costs cuts (informational) ─────────────
// CI-MRG-0028, 19 Sep 2026: SW-544 kept its old board's 22×28 after moving to
// the 23×38 board — 1 cut where the board gives 3. Not an error: a deliberate
// trim is the planner's call, and the planning screens already warn with a
// "Use the board's full sheet" button. Listed so a left-over size is seen
// before it is planned. Never affects the exit code.
if (lossyMasters.length || lossyLines.length) {
  console.log(`\ni ${lossyMasters.length} master(s) and ${lossyLines.length} open line(s) carry a parent that yields fewer cuts than their board`);
  console.log('  Usually a size left over from an earlier board. Not an error — the planner may keep a');
  console.log('  deliberate trim; the planning screens show the same warning with a one-click fix.\n');
  for (const { r, v } of lossyMasters)
    console.log(`    ${r.code.padEnd(9)} master parent ${v.declared.l}×${v.declared.w}" cuts ${v.cuts_declared}`
      + ` — ${r.board} (${v.board.l}×${v.board.w}") cuts ${v.cuts_board}`);
  for (const { r, v } of lossyLines)
    console.log(`    line ${r.id} (${r.status}) ${r.code} ${r.gang_number ?? '(single)'}`
      + `${r.co_printed ? ' · co-printed: its lock cuts the board' : ''}`
      + ` · parent ${v.declared.l}×${v.declared.w}" (${r.parent_is_job_override ? 'job' : 'master'}) cuts ${v.cuts_declared} vs board ${v.cuts_board}`
      + (r.parent_sheets_required != null ? ` · stored ${r.parent_sheets_required} parent / ${r.sheets_required} child` : ''));
}
```

- [ ] **Step 4: Run the tests and a syntax check**

Run: `cd server && node --test src/check-parent-fit-lossy.test.js && node --check ../scripts/check-parent-fit.mjs`
Expected: PASS, `# pass 4`, `# fail 0`, and no output from `--check`.

- [ ] **Step 5: Do not commit.**

---

### Task 10: Master safety and a scoped one-click (from the final whole-branch review, 19 Sep 2026)

**Why (Critical, final review).** "Use the board's full sheet" plus "Update Product Master(s)" can write a parent
into a Product Master that the master's OWN board cannot yield.
- It happens whenever the run or line sits on a JOB-ONLY board override while the master keeps its own smaller
  board. Run Smart Match or Manual picks write exactly that override (`/board`), and so does GRN substitution.
- The next order of the product then meets the 14-Sep lock refusal: the feature would create the very master
  defect it exists to prevent.

**Important (same review).** On a gang of different products, the one-click on ONE product's red row re-stamps
EVERY member's parent. That destroys deliberate trims, and writes board-sheet copies into masters that had no
parent.

- **A. Never an impossible pair on a master, and never a refusal.**
  - Add a pure helper `keepParentOffImpossibleMaster({ toMaster, toJob, master, masterBoard })` to helpers.js.
    - When `toMaster` carries `parent_l`/`parent_w`, judge the RESULTING master pair against the RESULTING master
      board. The pair is `toMaster.parent_* ?? master.parent_*`. The board is resolved by the caller from
      `toMaster.board_material_id ?? master.board_material_id`.
    - Use `parentFitsBoard`, where unsized means "cannot judge", which never blocks.
    - When it does not fit, the parent fields move to the job override, and the helper returns `keptJobOnly`.
  - Both master-write sites use it: `/gang-runs/:id/shared` (per member, before its master UPDATE) and plan-save
    (orders.js, after `splitMasterFields`).
  - Both responses say it: `/shared` answers `parent_kept_job_only: [codes]`, and plan-save answers
    `parent_kept_job_only: true|false`. The client toasts append that the parent was kept for these jobs because
    the product master's own board can't yield it.
  - `check:parent` gains an informational list of masters whose own parent their own board cannot yield (the
    lock will refuse their next order), to run on prod after deploy.
- **B. The Run Sheet one-click fixes the product it is clicked on.**
  - Each red row carries the line ids of the members it covers and ITS board's sheet.
  - The one-click sends `{ parent_l, parent_w, line_ids }` with that row's board sheet.
  - `runSheetParent` takes the scope, and its boards-differ guard compares within the scope.
  - `/shared` accepts `line_ids` only with a parent-only patch (anything else is a 400), and every id must be a
    member of the run. The member loop, `requestChangesCut` and the re-derive all run on the scoped lines.
  - The prompt names the scoped orders and products ("for 1 of the 3 jobs — SW-258").
  - A typed parent through Lock sheet stays run-wide, as documented.
- **C. The run engine's per-member cut lives in cutFit.js.**
  - `runMemberCut` gives each member's parent and cuts on ITS OWN board. The old fallback to the anchor's board
    for an unsized member counted the wrong sheet; an unsized member is now 1:1, as the server clamps it.
  - A parity test against the server's `memberParentSheets` arithmetic.
  - `gangCalc` calls it.
- **D.** On a member of a CO-PRINTED run, the single engine's Cut Plan warning does not claim "This plan uses X":
  that run's lock never reads the parent.

**Tests:**
- unit tests for the helper, including a board changing in the same write, an unsized master board, and one axis
  only;
- `runSheetParent` scope tests;
- `runMemberCut` parity;
- pins at both master-write sites, on the `/shared` `line_ids` validation, and on the client wiring.

**E2E on the mirror:**
- J5: a run on a job-only board whose master has a smaller board. One-click, then Update Product Masters: the
  master is unchanged, the jobs carry the parent, and the toast says so.
- A J2b-2 variant: the one-click on one product's row changes only that product.

---

#### Task 10, review round 2 (final reviewer's re-check, 19 Sep 2026)

**Critical: a master-level board move left the master's old parent behind.**
- After A keeps a too-big parent on the jobs, Lock sheet stays lit, because the run's board differs from the
  master's. The planner's next "Lock sheet → Update Product Masters" moved the master's BOARD and left its old
  parent: CI-MRG-0028 at master level, or an impossible master.

**Fix, decided by the controller:** every master write that carries `board_material_id` (`/shared` and
plan-save, co-printed runs included) judges the master's resulting parent with `masterParentCannotStay`.
- That function is the server twin of `parentFollowsBoard`'s condition: a copy of the old board's sheet, or a
  size the new board cannot yield.
- When the parent cannot stay, it is CLEARED (NULL) in the same master write. The master then cuts the board's
  full sheet and follows every future board by itself.
- The job's parent is deliberately NOT carried into the master: the planner never asked for that.
- Said in the response (`master_parent_cleared`), the toast and the audit.

**Important:** the `/shared` transaction body moves into an exported `lockSharedSheet(…, qc, oc)`, driven by a
stub-harness behavioural test (`lock-shared-sheet.test.js`). Both Criticals had passed every source pin.

**Minors:**
- the one-click no longer pre-fills the Run Sheet form, so Cancel can't leave a stray parent behind;
- the audit and toast wording reflect whether a master was actually written;
- `runMemberCut` counts a member with no child 1:1, like the server, except on co-printed runs.

### Task 9: Full verification and an end-to-end run on a local mirror (never prod)

**Files:** none changed. This task produces evidence for the report.

- [ ] **Step 1: Full suite + build + baseline gate**

Run: `npm run verify`
Expected: exit 0. The server suite reports `# fail 0`. The test count must equal 3112 plus the tests the
new files add. Count them with
`grep -c "^test(" server/src/parent-on-screen-client.test.js server/src/parent-loses-cuts.test.js server/src/member-parent-estimate.test.js server/src/run-sheet-parent-route.test.js server/src/co-printed-card-cuts.test.js server/src/planning-parent-screen.test.js server/src/check-parent-fit-lossy.test.js`.
The client must build.

- [ ] **Step 2: Build a local mirror of prod, read-only against prod**

Read the header of `~/.config/superpowers/worktrees/ci-erp/fluence-rx-tools/mirror-prod.mjs` for its flags,
then run it. It copies prod inside one `REPEATABLE READ READ ONLY` transaction over the session pooler (5432)
into its own local cluster (port 5477, database `cierp`). Confirm it prints matching table counts. **Never point
any step below at prod.**

- [ ] **Step 3: Boot this branch against the mirror**

Run (API, from the worktree root):
`DATABASE_URL=postgresql://postgres:postgres@localhost:5477/cierp PORT=4971 JWT_SECRET=verify-only-local node server/src/index.js`
Run (UI, second terminal):
`VITE_API_TARGET=http://localhost:4971 npm run dev -w client -- --port 5971`
Mint a token for the local process:
`node -e "console.log(require('jsonwebtoken').sign({id:1,name:'Verify',role:'admin'},'verify-only-local'))"`.
Put it in the browser pane as `localStorage.ci_token`, with
`localStorage.ci_user = JSON.stringify({id:1,name:'Anik Dua (MD)',role:'admin'})`.

- [ ] **Step 4: Journey 1: CI-MRG-0028's pre-fix state reads truthfully BEFORE the lock (mirror only)**

On the mirror DB: `UPDATE products SET parent_l=22, parent_w=28 WHERE id=1044;` then
`POST /api/gang-runs/139/reverse {}`.

`GET /api/gang-runs/139`, expect:
- `position.needed_gross` = 10650
- `position.short` = 7042
- `members[0].parent_l` = 22

Open the run in the UI and expect:
- To Issue 10,650 · Short 7,042 before any lock;
- the red Run Sheet row names SW-544, 22×28, 1 vs 3.

Click **Use the board's full sheet**, then **Update Product Master**, then Lock Run Plan. Expect:
- `products.parent_l/parent_w` = 23/38;
- the lock audit reads `5400 child → 1800 parent (3/parent, 2 ups)`;
- total 3,550, short 0.

- [ ] **Step 5: Journey 2: a run board change carries a copied parent (mirror only)**

On the mirror: `UPDATE products SET parent_l=23, parent_w=38 WHERE id=1044;` so the parent is a copy of board
399's sheet. In the run, pick a different-sized board through **Manual**. Expect:
- the Run Sheet Parent L/W to change to the new board's sheet, with the info toast;
- **Lock sheet →** to light up, and its prompt to list "Parent sheet" at the new size.

Choose **Update Product Master**. Expect the master's parent to equal the new board's sheet.

- [ ] **Step 5b: Journey 2b: two API checks on the Lock sheet route (mirror only)**

1. **Co-printed guard.** Send `POST /api/gang-runs/<CI-GANG-0019's id>/shared` with
   `{ "parent_l": 20, "parent_w": 38, "update_master": true }`.
   Expect:
   - 200;
   - no change to the members' `spec_override` or to their products' `parent_l`/`parent_w`;
   - no new `master_update` or `lock_sheet` audit row.
2. **A flagged order that isn't the lead.** On a merge run:
   - Give the lead a job-only parent equal to the board's sheet: `spec_override.parent_l/parent_w`.
   - Leave a later member on a master parent that loses cuts.
   - Open the run. Expect the red row on the later member.
   - Click **Use the board's full sheet**. Expect the prompt to show the Parent row.
   - Choose **Save for these jobs only**. Expect both members' effective parent to be the board's sheet, and
     the red row to be gone.

- [ ] **Step 6: Journey 3: single engine (mirror only)**

Open a pending single line whose product's parent equals its board's sheet. Switch the board through Manual to a
different size. Expect:
- the Parent L/W fields to follow, with a toast;
- on Lock, the master prompt to list parent_l/parent_w.

Then type a parent that costs cuts. Expect the red row to appear, and Lock to still succeed (no refusal).

- [ ] **Step 7: Journey 4: the co-printed card (mirror only, if CI-GANG-0019 can be carded there)**

If CI-GANG-0019's members can reach Push to Job Card on the mirror (artwork locked, board covered), push it and
expect `job_cards.children_per_parent` = 2. If they can't, record that, and rely on Task 5's tests plus
`SELECT` evidence that the mirror's CI-GANG-0019 lead carries parent 20×38 on board 380.

- [ ] **Step 8: The checker on the mirror**

Run: `node scripts/check-parent-fit.mjs --url postgresql://postgres:postgres@localhost:5477/cierp`
Expect:
- CHECK 3 lists GAL-001, GAL-072, SW-586 and FP-157/FP-216 (lines 328, 394, co-printed);
- the exit code is unchanged by CHECK 3 (`echo $?` gives the same result as before the change on the same mirror).

- [ ] **Step 9: Stop your local processes and report**

Stop only the processes you started (`lsof -tiTCP:4971 -sTCP:LISTEN | xargs kill`, and the same for 5971).
Run `git status` and `git diff --stat`, and confirm only the files in the File map changed.
**Do not commit, push, or deploy.** Report the evidence from Steps 1–8 to Anik and ask whether to ship.

---

## Self-review (done while writing)

- **Spec coverage:**
  - §1 → Tasks 1–2
  - §2 → Tasks 3, 4, 6
  - §3 → Tasks 6–7
  - §4 → Tasks 6 (run) and 7 (single)
  - §5 → Task 5
  - §6 → Task 8
  - "Deliberately unchanged" → no task touches `planLockParent`'s refusal, leftover geometry, the Product Master editor or GRN substitution
  - Testing and rollout → Task 9
- **No placeholders.** Every code step shows the code. Journey 4 is conditional with an explicit fallback.
- **Names are consistent across tasks:**
  - `sameSheet`, `cutParentOf`, `parentLosesCuts`, `parentFollowsBoard` (client);
  - `parentLosesCuts`, `coPrintedCardCuts` (server);
  - return shape `{ declared: {l, w}, board: {l, w}, cuts_declared, cuts_board }` on both sides;
  - `lockGangSheet(over)` is called with no arguments from the button and with `over` from the one-click fix.
