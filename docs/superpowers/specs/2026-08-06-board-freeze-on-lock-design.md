# Board freeze on lock — eliminating over-commitment

**Date:** 2026-08-06
**Ref:** written against `origin/main` @ `cb76028`
**Status:** implemented in the uncommitted `board-freeze` worktree; production prerequisite applied; copy-of-production route rehearsal passed; not deployed
**Migration:** `supabase/migrations/20260810060358_board_allocation_origin.sql` (remote Supabase version `20260810060139`)

---

## 1. The problem

The RM warehouse screen shows a red `+N over` badge on boards where planning has
locked more sheets than the shelf holds. On the live plant this is not an anomaly —
it is the designed output of the query.

`COMMITTED_DEMAND_SQL` (`server/src/replenishment.js:118`) builds committed demand
from two branches:

1. **Allocation branch** — active `board_allocations` rows for lines in
   `planned`/`ready`/`in_production`. Source-blind: it counts `source='requisition'`
   rows (board on order, not on the shelf) against the shelf.
2. **Remainder branch** — `GREATEST(need − allocated, 0)` charged to the line's
   nominal board (`replenishment.js:158-163`), regardless of what is on the shelf.

`stockSplit` (`server/src/replenishment.js:214`, twinned at
`client/src/lib/replenishment.js:57`) then computes:

```
committed = min(locked, gross)     the locks, capped at reality
net       = gross − committed      free to give
over      = locked − committed     locked beyond the shelf
```

**Root cause:** locking a plan does not reserve board.
`POST /order-lines/:id/plan` sets the line to `planned` and writes the cut plan; it
creates no `board_allocations` row of its own. The only write is via
`replaceMixPlan` when a mix is submitted. So for a normal locked job, "Committed" is
not a lock — it is branch 2's wish. `over` is what that wish exceeds.

The code records the scale: `replenishment.js:99-103` notes that only **2 of 63**
committed lines carry a hold — 5,000 sheets against 75,771 of real commitment.

## 2. Owner's rules

Verbatim, from the session:

> cover board if available, if not than raise pr or use alternate board, commit
> demand which cant be used by any other board. and keep warehouse and data simple.
> once i lock the plan and demand the stock freezes for the product, the engine can
> change or reverse it if asked.

> we have some adjustments in extra sheets and the leverage given to the cutting
> module. Do not impact that. Ensure that anyone can just issue or release from
> cutting or from extra sheet request only what is there on the shelf and is not
> committed.

Plus: restructure the RM warehouse columns so there is no confusion; add columns if
required.

## 3. Approved decisions

| # | Decision | Answer |
|---|---|---|
| 1 | Lock-time behaviour when the shelf is short | Freeze what is free, capped at the shelf. Alternate board offered before confirming. ~~raise a PR for the gap~~ — **superseded by decision 7**. |
| 2 | Jobs already on the floor at cutover | Back-fill holds capped at the shelf. **No auto-PRs** — gaps come out as a one-time shortage list. |
| 3 | Does a saved draft freeze? | **Yes**, and the screen shows it. Conditional on Discard becoming reachable everywhere first. |
| 4 | Where the extra-sheets gate bites | **Raise + Approve**. Issue stays soft and unrefusable. Approve is a soft refusal the XS approver may override with a reason. |
| 5 | Who may freeze | Anyone who may lock a plan (planner **and** production). Paired with: releasing a locked freeze becomes reason-bearing and audited. |
| 6 | Column count | Four **core** quantity columns: On Shelf, Frozen, Shortfall, Free to Promise. On Order and Buy Line remain as supporting columns at `ci-p3`. Net addition to the row is one column (Shortfall), paid for by merging PR+Incoming and demoting Grade. |
| 7 | Does the gap become a PR automatically? | **No — list it, do not auto-buy.** *Reverses the PR half of decision 1.* Freeze what the shelf holds; the shortfall shows in the shortage panel and the buyer raises the PR as he does today. |
| 8 | Are ganged runs frozen? | **Yes — per child, resolved by run KIND.** |
| 9 | Discard on a ganged job | **The whole run, from Manage Gang**, plus per-job for a plan saved but never locked. |
| 10 | What "Frozen" means on the screen | **Board spoken for by a planned job** — today's Committed figure, renamed. Not "holds only". See §6.3.1. Makes Phase 3 a pure client change. |
| 11 | Re-sourcing `suggestedQty` | **Deferred out of Phase 3.** It changes a quantity a human commits to a purchase document, and a partial fix returns the same wrong answer with every test green. Needs its own before/after on real boards. |

### 3.1 Decision 7 — why the auto-PR was dropped after being approved

Decision 1 originally approved "freeze what is free **and** raise a PR for the gap in one action". That was reversed once the sweep established a fact not known when it was decided.

`POST /order-lines/:id/raise-pr` nets out incoming board **only when `stock_booking = 'fresh_pr'`**. On an ordinary `'book'` line its shortage is `parent_needed − available_sheets` with no incoming term at all, and the route carries no server-side duplicate guard. So a planner pressing **Raise PR** after the engine had already auto-raised one would **order the same sheets twice**.

Two supporting reasons: locking a plan is a daily act, so this would create requisitions faster than all three existing auto-raise paths combined; and a PR is the only thing in Phase 2 that would write outside `board_allocations` (`requisitions` + `requisition_lines` + a burned `CI-PR-` number), breaking both promises made to the owner — that this work only ever adds to the claims register, and that one statement reverses the back-fill.

Dropping it keeps every promise literally true. The auto-PR can be added later, behind a fix to the Raise PR button, without touching anything shipped.

### 3.2 Decision 8 — the gang rule, in the owner's terms

> "we will consider the child for that particular run, not what its master says. However, do not conflict with the combined orders which we have merged for one product … for that, we will fetch the data from the master itself."

This is not a new concept. It is the existing `gang_runs.kind` column, and the resolution rule is **by run KIND, never by "owns an order line"** — the same precedent that governs output-number resolution.

| `kind` | What it is | Freeze resolved from |
|---|---|---|
| `gang` | DIFFERENT products on one shared sheet; splits into one child job card per product after die cutting | **the child** — one hold per member, sized to that member's own issued parent sheets |
| `merge` | a COMBINED RUN: the SAME product across several sales orders; never splits | **the master** — `db.js` states it: *"ONE product printed from its own master plate and die, so it keeps reading the master"* |

The freeze is placed when the run is locked **or saved**, consistent with decision 3. Nothing is committed before that point.

Implementation constraint: `board_allocations.order_line_id` is NOT NULL and there is no gang column, and every gang reader (`gangIncoming`, `gangPosition`, `claimsByBoard`, `syncPrAllocation`'s mirror) sums rows keyed on **member** lines. A parent-level row has nothing to hang on and would be invisible to the run's own shortage figure. So the cap must be struck once at RUN level and prorated across members — otherwise the first members freeze fully and the last one refuses, rolling back the whole lock.

## 4. Architecture

### 4.1 Branch 2 is not deleted

Branch 2 charges only `GREATEST(need − allocated, 0)`. Once a lock places a hold,
the shortfall figure shrinks by construction. **No SQL is removed.** Branch 2 stops
being the bug and becomes the `Shortfall` column: demand the engine could not freeze.

A planned-but-unlocked line still has real demand, so deleting the branch would
under-report — the dangerous direction.

### 4.2 The freeze reuses the existing mechanism

`POST /board/commit` (`server/src/routes/board.js:433`) already writes exactly the
row we need. Verified semantics:

- `qty` is the **total** the line should hold, not an increment. The server holds
  the difference, so a repeat press is a no-op returning `{committed: 0, already: true}`.
- The one hard gate is `qty_delta > boardPosition().free`, refused as HTTP 409
  `{ error, code: 'COMMIT_EXCEEDS_FREE', free }` (`board.js:463`).
- The INSERT writes `source='stock'` with `job_board_mix_id` NULL.

**Blocker:** all of this arithmetic is inline in the route handler and the handler
opens its own transaction. `/order-lines/:id/plan` already runs inside a `tx`, so it
cannot call the route. The arithmetic must be extracted into a function both call.

### 4.3 The hold taxonomy — why the board_allocation_origin migration is required

`board_allocations` currently distinguishes rows by `source` and `job_board_mix_id`:

| source | job_board_mix_id | meaning |
|---|---|---|
| `stock` | NULL | hand-placed by the planner via the Commit button |
| `stock` | set | mirror of a board-mix row |
| `requisition` | — | incoming PR board, not on the shelf |

A plan-lock hold is a **fourth** kind, and none of the existing predicates can
express it.

This matters because commit `9757c5f` taught `replaceMixPlan` to **absorb** a line's
hand-placed holds — `source='stock' AND job_board_mix_id IS NULL AND material_id = ANY(...)`,
with `release_reason='absorbed into the board mix for this job'`
(`server/src/helpers.js:922`). That fix exists because committing 500 by hand and
then locking a 2,000-sheet mix row on the same board left 2,500 held against a plan
needing 2,000.

A plan-lock hold written naively carries exactly the absorbed shape, so **every mix
save would silently eat the freeze**.

Rejected alternatives:

- **A new `source` value** — `source` is `CHECK`-constrained, and twelve filters
  (including the cutting gate) test `source='stock'`. A new value makes frozen
  sheets read as *free* at the gate. Unacceptable.
- **A `reason` prose tag** — `reason` is user-typed on both `/board/move` and
  `/board/commit`. Forgeable.

**Decision:** the `board_allocation_origin` migration adds a nullable identity column `origin` to
`board_allocations`, `CHECK (origin IS NULL OR origin IN ('plan_lock'))`, default
NULL. `source` stays `'stock'` so every existing free-stock filter and the cutting
gate keep working unchanged.

NULL means "every row written before this migration, and every hand-placed or
mix-mirrored row after it" — i.e. the existing taxonomy is untouched and the four
kinds are now:

| source | job_board_mix_id | origin | meaning |
|---|---|---|---|
| `stock` | NULL | NULL | hand-placed via the Commit button |
| `stock` | set | NULL | mirror of a board-mix row |
| `stock` | NULL | `plan_lock` | **new** — frozen by locking the plan |
| `requisition` | — | NULL | incoming PR board, not on the shelf |

The ABSORB predicate must therefore gain `AND origin IS NULL`, which is the minimum
change that leaves its existing behaviour byte-identical for the rows it already
matched.

### 4.4 Three changes the marker forces

Whatever marker is chosen, the same change must:

1. **Re-scope the ABSORB** in `replaceMixPlan` so it does not swallow a plan-lock hold.
2. **Add a consume path** at cutting start, beside `consumeMixHolds` /
   `consumeCoverHolds`.
3. **Add a release** to all four un-plan paths. `clearMixPlan → releaseMixHolds` is
   scoped `job_board_mix_id IS NOT NULL` and will not see the new hold.

Missing (2) or (3) strands board with no screen able to give it back — a defect that
is **already live today** for `/board/commit` holds.

## 5. The gates

### 5.1 Cutting — no change required

`issuableFor` (`server/src/board-allocation.js:63`) already states the owner's rule:

> A job may take its own hold plus whatever is free; it may never take another job's hold.

It reads the same `board_allocations` rows the freeze writes, so more holds tighten
it automatically, provided the new hold carries `source='stock'`. `assertFreeToIssue`
(`server/src/helpers.js:704`) is the enforcement point.

### 5.2 Extra sheets — gate moves earlier, Issue untouched

The Issue step must keep never refusing. `server/src/routes/extrasheets.js:347`
records the repeal verbatim: *"Task 12 removes the refusal."* The reason is physical
and unchanged — by the time the warehouse clicks Issue, the operator has already
carried the sheets off the floor and the plant head has already approved the
quantity. Refusing the paperwork cannot put board back on the pile.

New gates:

- **Raise** — hard refusal against board frozen to another job.
- **Approve** — re-check; soft refusal the XS approver (`users.xs_approver`) may
  override with a reason.
- **Issue** — unchanged. Still computes gross/locked/free as facts, not as a gate.

The numbers for both new gates are already computed and already displayed on those
screens; nothing is enforcing them.

### 5.3 Write-on leverage survives

`issueWithWriteOn` permits exceeding the shelf for board that has **physically
already moved**, clamping the book at nil rather than going negative. Physical-count
paths (manual inventory adjustment, write-on recount reconcile) depend on this: the
book must always be tellable what is actually on the shelf. **No freeze rule may
ever refuse a count correction.**

## 6. RM warehouse columns

### 6.1 The confusion being removed

The screen carries **three different board-demand numbers under overlapping names**:

1. `committed_qty` from `COMMITTED_DEMAND_SQL` — the Committed column and KPIs.
2. `reserved` / `demand` from `BOARD_DEMAND_SQL` grouped by **nominal** board —
   invisible as a column, but silently drives the Health cell, the PR quantity the
   Raise-PR flow seeds, and the Material 360 "Demand" tab, where it is labelled with
   the same word *Committed*.
3. `issuableFor.free` — the gate cutting and extra sheets actually hit, which appears
   nowhere on this screen.

Definitions (1) and (3) converge under this design. Definition (2) does not move at
all, and it is the one wired to the alarm and the buy suggestion.

This is why a row can read `Health: OK` beside a 3,000-sheet hole.

### 6.2 New quantity block

One unit rule: **every quantity column renders packets-over-sheets.** Today Net Stock
and Reorder Level are bare sheets sitting beside three packets-over-sheets columns, so
a storekeeper converts one of the pair in his head.

Column order matters and is part of the spec. The three figures that **add up** sit
together, then the shortfall sits directly beside the thing that answers it:

| # | Column | Was | Definition |
|---|---|---|---|
| 1 | **On Shelf** | Available (Packets / Sheets) | physical stock, `status='available'` batches |
| 2 | **Frozen** | Committed (Planned) | active `source='stock'` holds on this board; sub-line "N jobs" |
| 3 | **Free to Promise** | Net Stock | On Shelf − Frozen |
| 4 | **Shortfall** | *new* | `stockSplit(m).over_committed` — demand this board could not cover. Red when > 0 |
| 5 | **On Order** | PR Raised + Incoming (PO) | merged two-line cell: PO over PR |
| 6 | **Buy Line** | Reorder Level | same figure, now packets-over-sheets |
| 7 | **Health** | Health | redefined — see 6.4 |

Columns 1-3 satisfy `On Shelf = Frozen + Free to Promise` and must stay adjacent, in
that order, so the identity is readable straight off the row. Column 4 is deliberately
**outside** that group — it is demand, not stock, and it is the only figure on the row
that may exceed the shelf. Column 5 follows it because "short 7,893 · 12,240 on order"
is the sentence a buyer needs to read in one movement.

**Vocabulary — the same figure carries two names, deliberately.** The row column is
**Shortfall** (a quantity a storekeeper reads); the clickable KPI card above it is
**To arrange** (an action a buyer filters by). This is not drift and must not be
"corrected" to one word: the column states a fact, the card starts a task. Anything
that prints the figure as a number uses Shortfall; anything that offers it as a
worklist uses To arrange.

Removed: **Total Weight** — it is On Shelf × Kg/Sheet with both inputs already
columns two apart, and the KPI headline is already tonnage. If the owner wants it
kept, keep it at `ci-p3` and drop Buy Line to a tooltip instead.

Demoted to `ci-p3`: **Grade** — the grade rail above the table is the grade control;
on a tablet the row repeats the chip the user just pressed. This demotion pays for
Shortfall so the tablet-landscape row does not grow.

The word **Available** must go. Under a freeze regime a planner reads it as
*available to promise*, which is now a different column.

### 6.3 Why Shortfall earns its place

It is a replacement, not an addition. Today the red `+N over` badge is the only thing
on a row that says *this board is the bottleneck*. When over-commitment stops
happening, that badge goes to zero — and a board at Free to Promise 0 **with a PR
raised** becomes visually identical to one at Free to Promise 0 **with nothing
behind it**. Shortfall is what became a PR or a board switch. It costs no new SQL.

### 6.3.1 What "Frozen" means — decision 10

An earlier draft of §6.2 defined Shortfall as *branch 2 of `COMMITTED_DEMAND_SQL`*, while §6.3
said it *"costs no new SQL"*. Those contradict: branch 2 is summed into `committed_qty` before the
route sees it, so isolating it **would** require new SQL. The contradiction is resolved here.

**Frozen is board spoken for by a planned job** — the figure the screen calls Committed today,
renamed. It is `stockSplit(m).committed`, and Shortfall is `stockSplit(m).over_committed`, the
part of that claim the shelf cannot cover.

Rejected: Frozen as *active `source='stock'` holds only*. It is the sharper word, but it costs new
SQL, an edit to arithmetic twinned across client and server, and a hard dependency on the back-fill
having been run. Worse, **until the back-fill runs it reads near-zero on every board**, so Free to
Promise would look far larger than it is — planners promising board that is already spoken for,
which is the dangerous direction and the exact failure this project exists to remove.

The two definitions converge in practice where it matters: because the freeze refuses to exceed
free stock, on every board where demand beats the shelf they produce the **same** shortfall. They
part only where the shelf could cover a job but nobody re-locked it — and there the answer is to
re-lock, not to buy.

Consequence: **Phase 3 is a pure client change.** No SQL, no server edit, no back-fill dependency,
and `On Shelf = Frozen + Free to Promise` holds because it is `stockSplit`'s own asserted invariant
with an existing test behind it.

### 6.4 Health

Health must stop reading `short`, whose input `reserved` is blind to
`board_allocations` and would contradict the row it sits in. Four states, all read
off the columns beside it so the cell can never disagree with them:

- **RECOUNT** — `open_writeon_qty > 0`, or `over_committed > 0` after an adjustment
  dropped the shelf under live holds
- **FROZEN OUT** — Free to Promise is 0
- **BELOW LINE** — Free to Promise < Buy Line
- **OK**

This is also the only home for `open_writeon_qty`, which the endpoint already ships
and this screen — the one that orders the recount — has never rendered.

### 6.5 Knock-on changes in the same phase

- **`suggestedQty` must read Shortfall, not `reserved`.** Today the PR quantity is
  `reserved + reorder − available − incoming`, which computes 0 against a board whose
  entire shelf is frozen. If the buy suggestion keeps reading a demand definition the
  freeze does not move, the "if not available raise a PR" rule raises the wrong PR or
  none at all.
- **Material 360 Demand tab** must be relabelled and re-sourced, or the drawer opened
  from a row keeps contradicting that row using the same word.
- **RM Leftover list** must gain Frozen / Free to Promise / Health from the same
  helpers, or a banked offcut strip reads as fully free by construction.

### 6.6 KPI strip

Six cards, one filter each. Add every key to `RM_KPI_LABEL`, which today is missing
`over` outright — so the fault card produces the only nameless notice.

1. **On shelf** — reset, unchanged
2. **Frozen for jobs** — drop the red "+N short" suffix; keep products/lines/boards
3. **Free to promise**
4. **To arrange** — replaces "Over commit" in the same slot, same icon; reuses
   the existing open/answered split verbatim
5. **On order** — merges PR and Incoming; sub-line "X on PO · Y on PR"
6. **Below buy line** — unchanged predicate; value must carry the word "boards",
   being the only card whose value is a count

The strip identity restates as **On shelf = Frozen + Free to promise**, and now holds
for a better reason: not because `stockSplit` clamps with `Math.min`, but because the
freeze refuses to exceed free. Keep the clamp anyway — a recount can still drive
available below live holds after the fact — but its output now feeds the Health
RECOUNT state, not a planning card.

## 7. Pre-existing bugs in the blast radius

All three are live today and get materially worse once every locked line holds board.
They must be fixed in this change or it creates the problem it removes.

Each is stated with the verification behind it, because one claim from the sweep did
not survive checking and is corrected here.

1. **`alloc_repoint` has no source predicate.** *(verified — `routes/procurement.js`,
   the `alloc_repoint` branch.)* It runs
   `UPDATE board_allocations SET material_id=$1 WHERE order_line_id=$2 AND material_id=$3 AND status='active'`
   with no `source` filter, while its sibling `alloc_release` eleven lines below
   explicitly scopes `AND source='requisition'`. Today this only ever moves PR
   mirrors, because a locked line rarely carries a stock hold. Once every locked line
   holds board, a substitution drags a shelf freeze onto a board whose sheets are
   still in quarantine. **Preserve the PR-mirror repoint; scope it to
   `source='requisition'` so it cannot move stock holds.**

2. **`planMove` emits no release for the giving line.** *(verified —
   `board-allocation.js`, `planMove`.)* Its effect vocabulary is exactly three kinds:
   `hold` (receiving line takes from the warehouse), `pr_down` (absorb the receiver's
   open PRs), `pr_new` (the giving line gets a replacement PR). Nothing reduces the
   giving line's own hold. Today that is harmless because the giver usually has none.
   Once every locked line holds board, a move adds a hold to the receiver while
   leaving the giver's intact — double-counting the same sheets.

3. **`rollbackLine` strands the PR mirror in `rollback` mode only.** *(corrected — the
   sweep reported this as a blanket stranding; it is narrower.)* `rollbackLine` calls
   `clearMixPlan`, which releases the **mix-mirrored** hold with a reason on record,
   and the code comment says so explicitly. But `releaseMixHolds` is scoped
   `job_board_mix_id IS NOT NULL`, so it covers mix mirrors only. Meanwhile
   `DELETE FROM requisitions WHERE order_line_id=$1 AND purchase_order_id IS NULL`
   nulls `requisition_id` on the PR mirror via `ON DELETE SET NULL` and leaves the row
   `active`. In `mode='delete'` the line's own cascade cleans it up; in
   `mode='rollback'` the line survives and the mirror is stranded. **The same scoping
   gap means neither a hand-placed hold nor a new `plan_lock` hold is released by a
   rollback either** — which is the concrete form of §4.4 item 3.

## 8. Draft holds

A draft with a balanced mix already calls `replaceMixPlan` and already writes real
active `source='stock'` holds on a `pending` line, and those holds are already
honoured by the cutting gate and the extra-sheets screen. Branch 1 filters
`status IN ('planned','ready','in_production')`, so today the warehouse screen hides
them. Under this design they become visible as Frozen.

**Blocking prerequisite:** a draft's hold has exactly one release button
(`POST /order-lines/:id/plan/discard`), offered only inside Planning, and it refuses
outright on a ganged line. A member saved solo then tagged Gang fences board with no
screen anywhere able to release it. **That gap must close in the same change.**

Preserve: a draft that omits the mix key leaves stored mix rows untouched — *"save my
work"* must not throw away a half-built mix. An empty array is still a deliberate clear.

## 9. Must not break

| Behaviour | Proof |
|---|---|
| Extra-sheet Issue never refuses | `routes/extrasheets.js:347` — the repeal is recorded verbatim |
| Cutting grants own hold + free, never another job's | `board-allocation.js:58` |
| Board beyond what a job can use stays in `free` | `boardPosition` caps each hold at that line's need, reports surplus as `over_held` |
| One number per (line, board) | the ABSORB block, `helpers.js:922` |
| `releaseMixHolds` runs BEFORE mix rows are deleted | deleting first nulls the link via `ON DELETE SET NULL` |
| A draft omitting the mix key leaves it alone | `routes/orders.js` draft branch |
| GRN substitution re-points the PR mirror | else the QC burn-down credits the job twice |
| A combined run's drawn board stops being owed | `replenishment.js:126-143`, commit `cb76028` — landed after the sweep's first read |
| The Commit button may only take FREE stock | `/board/move` is the sanctioned way to take board off another job, and it asks its own questions |
| `issueWithWriteOn` clamps at nil for board already moved | physical-count paths depend on it |

## 10. Testing

Coverage on every surface being touched is **effectively zero**: `/board/commit`,
`/board/uncommit`, the ABSORB block, and the whole draft/discard path. Tests are part
of this change, not follow-up.

Required:

- The client/server twin rule — `server/src/replenishment.js` is mirrored at
  `client/src/lib/replenishment.js` and a test asserts they agree. Both must move together.
- A property test that `On Shelf = Frozen + Free to Promise` holds per board and for
  any sum of boards, including after a recount drives available below live holds.
- A test that a mix save does **not** absorb a plan-lock hold.
- A test that each of the four un-plan paths releases the hold.
- A test that the extra-sheets Issue step still succeeds against zero free stock.
- A test that a `production` login can lock and freeze.

## 11. Delivery order

This is too large for one sitting. It decomposes into four phases, each independently
shippable and each leaving the system consistent. **Phase 1 must land before Phase 2**,
because a freeze written without the marker is destroyed by the next mix save.

**Phase 1 — foundations (no visible change).**
the `board_allocation_origin` migration; re-scope the ABSORB; extract `/board/commit`'s arithmetic into a
callable function that takes a transaction; close the `commitInputs` race; fix the
three blast-radius bugs in §7. Tests for `/board/commit`, `/board/uncommit`, and the
ABSORB. Nothing on screen moves.

**Phase 2 — the freeze.**
`/plan` places the hold and raises the gap PR; add the consume path at cutting start
and the release on all four un-plan paths; make Discard reachable everywhere
(including on a ganged line). One-time back-fill for live lines, capped at the shelf,
producing the shortage list. No auto-PRs.

**Phase 3 — the gates.**
Extra sheets: hard gate at Raise, soft override-with-reason at Approve. Issue
untouched. Cutting needs no change; add a test proving it.

**Phase 4 — the screen.**
The RM column rebuild, Health redefinition, KPI strip, `suggestedQty` re-source,
Material 360 relabel, Leftover list columns.

Phases 3 and 4 are independent of each other and may be done in either order.

## 12. Out of scope

- Netting across boards. Every figure stays per-board: a surplus of Saffire is not
  cover for a hole in Duplex.
- Changing what `BOARD_DEMAND_SQL` means. It is retired from the row, not redefined.
- Any change to gang run numbering or output-number resolution.

## 13. Open risks

- `origin/main` moves fast — `cb76028` edited `COMMITTED_DEMAND_SQL` one day before
  this spec. Re-read that SQL immediately before implementing.
- `/board/commit` reads availability and allocations **outside** its transaction
  (`commitInputs` runs on the pool), so two planners committing different lines on the
  same board can both pass the gate. This is a live over-commit race that the extracted
  function should close.
- `/board/uncommit` does not exclude mix-mirrored holds, so it can release a locked
  mix's board and orphan the `job_board_mix_id` link.
