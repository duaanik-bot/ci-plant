# Gang co-print parent requirement — one gang-level figure, not a sum

**Date:** 2026-08-11 · **Scope:** shared-layout (co-printed) gangs only · **Status:** approved by Anik in-session

## Problem

A shared-layout gang prints every member on ONE sheet, so the run needs the MAX any member
requires — the server (`sharedLayoutRun`) already computes this and stores proportional
shares on plan/save/re-derive. But the **client's `gangCalc`** (Planning.jsx) — the live twin
driving the members' SHEETS column, the engine footer, the Lock caption, `gangIssueNow`, the
Board Mix target and takeable — **sums per-member naturals regardless of `layout_mode`**.

Observed on CI-GANG-0010 (Rosutrack 2,000 @ 2-up · Alamin 1,000 @ 1-up · child 18×25 on
25×36 · 200 child wastage):

- Screen said **1,100 parent sheets** (600 + 500 naturals) — the sum.
- Correct co-printed figure: run = max(1000, 1000) + 200 = **1,200 child ÷ 2 cpp = 600 parent**.
- DB additionally carried `issue_parent_sheets = 1200` — the banner's **child** figure typed
  into the **parent** issue box (it re-seeds itself every open), and member figures stored
  from an old save computed with master ups (3/2) before the per-line overrides (2/1) landed.

Plant impact: Board Mix, shortage and PR sizing quote roughly double the board a shared run
actually needs.

## Design

1. **Server `gangDetail` (gangs.js)** — shared branch, `kind !== 'merge'`, layout settled:
   - `MEMBER_VIEW` additionally selects `p.parent_l, p.parent_w` (the finalised parent trim).
   - `layout_run` gains `cpp` (childFit count, parent trim over board mother sheet — the same
     chain the plan lock uses), `run_parent = ceil(run_child / cpp)`,
     `need_parent = ceil(need_child / cpp)`.
   - `position.needed` (and therefore `short`) quotes `run_parent` instead of the per-member
     sum when the run figure is computable; falls back to the sum exactly as today otherwise
     (pending layout, missing ups).
   - `total_parent_sheets` keeps its meaning (sum of stored member shares) — other readers
     (suggestions, engine context, toasts) untouched.

2. **Client twin `client/src/lib/gangRunMath.js`** — pure, imported by Planning.jsx and by the
   server parity test (same discipline as boardMath/boardMix):
   - `sharedRunFigures(members, { wastage, cpp })` → `{ needChild, runChild, needParent,
     runParent, childWastage, parentWastage, totalUps, per: [{ id, ups, needChild,
     yieldPieces }] }`; returns **null** when any member lacks ups (client degrades to the
     sum + the existing "enter ups" banner; the server twin throws — soft mirror by design).
   - `parentWastage = runParent − needParent` (fixture: 600 − 500 = 100).
   - `yieldPieces = runChild × ups` (what the run yields if every sheet prints — the figure
     Anik specified: 2,400 / 1,200 pcs).

3. **`gangCalc` becomes layout-aware** — when `kind !== 'merge' && layout_mode === 'shared'`
   and the twin computes: headline `parent` = `runParent`; the old sum is kept as
   `naturalParent`; per-member naturals stay in `per` (the 600/500 reference column);
   `sharedMode: true`. Every existing consumer of `gangCalc.parent` (gangIssueNow, Lock
   caption, Board Mix target, myCommit.takeable, footer) automatically speaks the run figure.
   `cpp` prefers the server's `layout_run.cpp`; clientFit only as fallback.

4. **Display** (Gang Engine, shared mode only):
   - Members table SHEETS column keeps per-product naturals (reference, as specified).
   - Member sub-line gains the run yield: "→ 2,400 pcs".
   - Footer: **Adjusted parent requirement 600** · products' own sum 1,100 (reference) ·
     wastage 200 child → 100 parent.
   - Co-printed banner appends the conversion: "1,200 sheets … → **600 parent**".
   - Issue box: computed default is the run parent; a stored override that disagrees with the
     computed figure gets an explicit chip ("override 1,200 ≠ computed 600 — clear") — no
     silent deletion of planner intent.

5. **CI-GANG-0010 repair — no SQL.** Members are still `pending` (draft ⇒ no derived demand).
   After the fix ships: open the gang, clear the stale override, Save — the server re-derives
   correct shares.

## Geometry decision (found during verification)

The server's shared branch converted child→parent through
`childFit(effectiveParent(effs[0], board), effs[0])` — the LEAD MEMBER's solo parent trim.
SW-586 carries `parent_l/w = 23×36`, which fits the 18×25 child ONCE, so the plan lock itself
had priced this run at **1,200 parent** (that's where the stored `issue_parent_sheets = 1200`
and the 720/480 member figures came from — cpp 1, master-ups 3:2 split). The shared 25×36
board cuts the child TWICE (100% util).

Rule adopted: **a co-printed run's parent conversion uses the SHARED BOARD's own sheet,
never a member's solo parent trim** — a trim describes how that product cuts when planned
alone. Applied identically in all three sites: the plan lock, `reDeriveMemberSheets`'s shared
branch, and the new `gangDetail` figures. Solo lines and separate-mode gangs keep
`effectiveParent` untouched.

Known related asymmetry, out of scope: the run's Board Mix context still measures its strip
preview on the lead's trim (`planned_parent_l/w`) — display-only, flagged for a later session.

## Verified

- 1,719/1,719 server tests pass; client builds clean.
- Live read-only preview on CI-GANG-0010: banner "1,200 child sheets → 600 parent
  (2/parent)"; members 600/500 reference with yields 2,400/1,200 pcs; footer "600 parent
  sheets — one co-printed run · own sum 1,100 · wastage 200 child → 100 parent"; stale
  override flagged "issuing 1,200 vs calculated 600" with reset; after reset, Board Position
  TO ISSUE 600, short 2,584 → 1,984, Lock caption 600.
- API: CI-MRG-0012 (merge) payload byte-identical in shape — no `layout_run`, position off
  stored sum; CI-GANG-0010 `layout_run {run_child 1200, cpp 2, run_parent 600}`,
  `position.needed 600`.

## Pre-deploy review findings (fixed before push)

An adversarial multi-agent review of the deploy diff confirmed three defects, all fixed:

1. **`MEMBER_VIEW` had no `dispatched_qty`** — `netProduceQty` nets ordered − FG − dispatched,
   so gangDetail's recompute (and the client twin) silently re-priced the WHOLE order on a
   member re-planned after a partial dispatch, and `raise-pr` would buy the phantom shortage.
   The view now carries the column; the client's `netOf()` matches the server helper exactly.
2. **`position.needed` ignored the stored issue override** — the lock distributes
   `issue_parent_sheets` across members and the job card draws that sum, so Board Position
   now demands `gang.issue_parent_sheets ?? run_parent` (what the floor will actually draw);
   the override chip beside the computed figure keeps a stale override loud.
3. **Converted merges could co-print** — `/convert-to-merge` kept `layout_mode='shared'`,
   and the plan lock + `reDeriveMemberSheets` shared branches keyed on layout_mode alone —
   a converted merge would take the MAX when a merge's truth is the SUM of its sales orders.
   Both branches now guard `kind !== 'merge'` (matching gangDetail) and convert stamps
   `layout_mode='separate'`.

## Explicitly untouched

- Combined/Merged runs (`kind === 'merge'`) — never enter the shared branch, client gates too.
- Separate-mode gangs — run = sum is that toggle's deliberate maths.
- Single-line plans; all server plan/save/re-derive maths (already correct).

## Tests

- `server/src/shared-layout.test.js` (or sibling): parity — client twin vs
  `sharedLayoutRun` + `parentSheetsRequired` on the CI-GANG-0010 fixture (600/500 naturals ·
  1,200 child · cpp 2 · 600 parent · 100 parent wastage · yields 2,400/1,200) plus the
  ratio-mismatch and missing-ups cases.
- gangDetail payload shape covered indirectly via the pure helpers; visual verify in the
  local app on CI-GANG-0010 (adjusted 600 · reference 1,100), merge + separate spot-checked
  unchanged.

## Non-goals / notes

- Not committed/pushed/deployed — session default. Work lives in the
  `fix/gang-coprint-parent-requirement` worktree.
- The banner's historical child/parent ambiguity is what minted the stored 1200 override;
  the conversion suffix is the guard.
