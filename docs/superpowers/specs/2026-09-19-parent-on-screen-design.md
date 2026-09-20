# Parent on screen: the cuts the planner sees are the cuts the lock writes

**Date:** 2026-09-19 · **Status:** approved in session by Anik, with his amendment below
**Branch:** `fix/parent-on-screen` (worktree `~/.config/superpowers/worktrees/ci-erp/mrg0028-relock`, off `origin/main` 9bfb3b14). Nothing is committed or deployed.

## Why

CI-MRG-0028 (SW-544, 2 sales orders) showed **Covered** before its lock: 3,550 to issue against 3,608 in the
warehouse. After **Lock Run Plan** it showed **Short 7,042**. Root cause:

- SW-544's master declared a parent of **22×28"**, the sheet of its OLD board (#53, Duplex WB 350 22x28).
  On 18 Sep, "Lock sheet → save to product master" moved the product to board #399 (**23×38**). That route
  writes board, child size and coating. It never writes the parent, so the old size stayed behind.
- The run screen counts cuts on the **board** (`gangCalc`, and `memberParentSheets` before the lock):
  3 cuts, 3,550 sheets. The run lock and `readiness()` count them on the **declared parent**: 1 cut, 10,650.
  The run screen never shows the parent, so the planner could not see the second figure coming.
- The 14-Sep guard (`planLockParent`) refuses only a parent LARGER than the board. 22×28 can be trimmed
  out of 23×38, so it passed without a word.

The data was fixed live on 2026-09-19 (parent cleared, run re-locked at 3,550). This spec covers the code.

## The contract (Anik, in session)

1. **No new locks or hard blockers.** Whatever the planner types in either planning engine (parent size,
   child size, cuts) is used as typed.
2. **Changing one asks the usual question.** "Update Product Master / This job only": the single engine
   asks through its Lock master prompt, the run engine through its Lock sheet prompt.
3. **The screen never counts on a parent the planner cannot see.** The figures on screen are the figures the
   lock writes.

This amends the earlier in-session pick "Refuse + one-click fix". The one-click fix stays. The refusal
becomes a warning that is always visible and never blocks.

## Design

### 1. One rule, two spellings (server rule + client twin)
- **Server** `helpers.js`: `parentLosesCuts(product, board)` returns `null` or
  `{ declared: {l, w}, board: {l, w}, cuts_declared, cuts_board }`.
  - It judges only a declared parent that fits the board. A parent larger than the board is
    `parentFitsBoard`'s case and stays the existing refusal.
  - It returns `null` when there is no declared parent or when anything is unsized.
- **Client** `client/src/lib/cutFit.js`, twins over `clientFit`:
  - `parentLosesCuts({ parentL, parentW, boardL, boardW, childL, childW })`;
  - `cutParentOf({ parent_l, parent_w }, { sheet_l, sheet_w })`, the twin of `cuttingParent`;
  - `parentTooBig({ parentL, parentW, boardL, boardW })`, the twin of `!parentFitsBoard` for a parent that
    is present and sized;
  - `sameSheet(a, b)`, orientation-free equality;
  - `parentFollowsBoard`.

  The twins accept `null` arguments without throwing. One difference is deliberate: a blank form field (`''`)
  means "no parent, use the board's full sheet". The server only ever sees numbers or NULL.
- A test on the live fixtures pins that server and client agree.

### 2. The run engine shows and uses the parent its lock uses
- **`MEMBER_VIEW`** gains the effective `parent_l` and `parent_w` (override, else master).
- **`memberParentSheets(m)`** counts cuts on `cuttingParent(m's parent, m's board)`, so the Board Position
  before the lock equals what the lock writes. Co-printed (`layout_mode='shared'`) gangs keep the board,
  because their lock ignores declared parents. `gangDetail` passes the parent as null for them.
- **Client `gangCalc`** counts each member on `cutParentOf(its parent, its own board)`, the same pair
  the merge/separate lock uses. The co-printed arm is unchanged.
- **The Run Sheet gains Parent L / Parent W.**
  - Blank means the board's full sheet. The fields are seeded from the effective parent.
  - The "Child on parent: N/parent" preview uses them.
  - **Lock sheet →** sends them, and its existing prompt lists Parent beside Board, Child and Coating
    (Update Product Master / Save for these jobs only).
  - Co-printed gangs hide the fields and say "co-printed runs cut on the board's full sheet".
- **`POST /gang-runs/:id/shared`** accepts `parent_l` and `parent_w` (both, each > 0). It handles them
  exactly like `child_l`/`child_w`:
  - equal to master → the override is dropped;
  - `update_master` → written to the master;
  - otherwise → a job-only override.

  `reDeriveMemberSheets` then follows, as it already does for the child size.

### 3. The warning and the one-click fix (never a blocker)
- **Run Sheet.** A red row appears when the saved effective parent loses cuts:
  *"SW-544: parent on file 22×28" cuts 1 per sheet; the 23×38" board cuts 3. The figures on this screen use
  22×28."* The button **[Use the board's full sheet]** fills Parent L/W with the board's own sheet and opens
  the Lock sheet prompt.
- **Run Sheet, oversize parent.** When the saved parent is LARGER than its board (`parentTooBig`), the
  existing 14-Sep refusal will fire at lock. So the Run Sheet shows that too, *before* lock, with the same
  one-click button: *"…parent on file 25.6×28" is larger than the 23×38" board. No guillotine can cut it, so
  Lock Run Plan will refuse until it changes."* (The single engine already shows its own "larger than board"
  badge.)
- **Single engine.** The same row appears under Parent L/W when the typed parent loses cuts. The button fills
  the board's own sheet into the fields, and the Lock master prompt asks as usual.
- **Why the fill uses the board's own size.** It's a normal field edit, so the existing diff and the
  master/job question carry it end to end (`changedSpec` and plan-save skip blank values). A blank would
  need new "clear" plumbing, and a job-only override can't express "no parent" over a master value anyway.
- Lock is never blocked. The Lock button caption already shows the sheet count and the shortfall.

### 4. A board change carries a parent that cannot stay (visible, then asked)
- **When it applies.** A new board is picked while the current parent either
  - is a **copy of the OLD board's sheet** (`sameSheet`), or
  - **cannot be cut from the NEW board** (`parentTooBig`). The lock would only refuse such a parent, under the
    existing 14-Sep rule, so keeping it would be a guaranteed dead end.

  The parent fields are then set to the NEW board's sheet, with a note saying so.
- **A genuine trim that still fits is left alone.** The warning speaks if it loses cuts on the new board.
  (Decided in review, 2026-09-19. It is the conservative reading of the contract: a fill the planner sees
  instead of a refusal they'd hit at lock.)
- **Where:**
  - **Single engine:** `pickBoard`.
  - **Run engine:** after a Smart Match or Manual board pick (`setGangBoard`). The Run Sheet parent is
    pre-filled, so the sheet is dirty and **Lock sheet →** lights up. Until the planner saves it, the figures
    show the saved parent, and the warning says why.
- The server never changes a parent unless the planner saves it through Lock sheet or Lock.

### 5. A co-printed gang's card counts cuts the way its lock did
`createJobCardForGang` stamps `children_per_parent` from `readiness(lead)`, which counts on the lead's declared
parent. The co-printed lock counts on the board's own sheet.
- The CI-GANG-0019 shape (FP-157/FP-216: declared 20×38, board 23×38, child 19×21): the card would say
  **1** print sheet per parent against a plan made at **2**.
- **Fix:** for `layout_mode='shared'`, the card takes `childFit(board sheet, shared child)`.
- **Verify first:** if a failing test cannot reproduce the mismatch, this section is dropped.

### 6. The standing check (`npm run check:parent`)
- **CHECK 1 keeps its rule.** A locked plan priced in child sheets, counted on the parent its lock actually
  used, still fails the run.
  - One correction: it now reads the **effective** parent (job override, else master). Today it reads the
    master's alone, so a job-only parent was invisible to it.
  - It must **not** start flagging the CI-MRG-0028 shape as an error. Under the contract a deliberately kept
    trim is allowed, so a failing check there would be a false alarm.
- **CHECK 3 (new, informational; never fails the run)** lists active masters and non-closed lines (pending,
  planned, ready, in production) whose parent on file loses cuts on their board. It gives each line's status,
  stored figures and whether the parent is a job override or the master's. That is where a CI-MRG-0028-style leftover shows
  up for a human to judge. Today it lists GAL-001, GAL-072, SW-586 and FP-157/FP-216.

## Deliberately unchanged
- **The 14-Sep refusal** of a parent LARGER than the board (physically impossible) is current behaviour and
  stays. Softening it is a separate decision for Anik.
- **Leftover strip geometry** (`effectiveParent`) is already measured on the parent the lock uses.
- **The Product Master editor**: its Parent fields sit next to Board, in plain view.
- **GRN substitution.** Gang suggestions need no change either: they read `MEMBER_VIEW` through
  `memberParentSheets`, so they pick up the parent columns and the new estimate on their own.
- **No migration and no data change.** GAL-001, GAL-072 and SW-586 show the warning when they're next planned.

## Known gap, not in this change (found in Task 3 review)
Before a lock, `memberParentSheets` and `readiness()` book each member's **stored** `wastage_sheets` (or the
master's `wastage_pct` when none is stored). The non-shared run lock books the **typed** wastage on the lead
member only and 0 on every other member. So a run that is fresh, or reversed from solo plans, can still move
by up to its wastage allowance at lock (≈200 parent sheets on a 1-cut parent, ≈67 on a 3-cut board).

This predates this work and is a separate root cause. Fixing it needs one run-aware estimate that both
`gangDetail` and `readiness()` use; patching one alone would split the queue badge from the run modal. It is
proposed to Anik as its own follow-up.

## Success criteria
- On any merge or separate run, the Board Position, "Sheets to issue" and Lock caption before the lock equal
  the lock's written figures. Proven on the replayed CI-MRG-0028 pre-fix state: the screen reads 10,650 and
  Short 7,042 *before* the lock, with the warning naming 22×28.
- No new 409 anywhere. The only lock refusal remains the 14-Sep oversize one.
- Every parent change made in either engine goes through the Update Product Master / job-only question.
- A board change can't silently leave the old board's sheet behind as the parent.

## Testing
- **Failing tests first**, each shown failing on main before the fix:
  - the rule and client-twin parity on fixtures (SW-544, GAL-072, SW-586, SW-258, SW-097, unsized, none);
  - `memberParentSheets` with 22×28 = 5,400 = the lock's own arithmetic;
  - `cutParentOf` parity with `cuttingParent`;
  - co-printed card cuts (CI-GANG-0019 fixture → 2);
  - source pins for `gangCalc`, `pickBoard`, the Run Sheet fields and the `/shared` parent handling.
- **Existing tests stay green:** `plan-lock-parent`, `cutting-parent-fallback`, `parent-demand`,
  `parent-fits-board`, `run-leftover-basis`.
- **Full check:** `npm run verify`.
- **End to end on a local mirror of prod** (mirror-prod method; no writes to live):
  1. replay CI-MRG-0028's pre-fix state;
  2. a run board change that carries the parent;
  3. a single-engine board pick;
  4. the CI-GANG-0019 card.

## Rollout
Branch only. Nothing is committed or deployed until Anik says so in the session. When sanctioned: no migration.
Run `check:parent` on prod before and after. Prove the deploy by chunk size.
