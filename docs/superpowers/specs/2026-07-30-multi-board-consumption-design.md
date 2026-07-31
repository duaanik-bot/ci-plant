# Multi-Board Consumption in the Planning Engine

**Date:** 2026-07-30
**Branch:** `multi-board-consumption`, worktree `~/.config/superpowers/worktrees/ci-erp/multi-board`, based on `main@aa26e5e`
**Status:** design approved, not yet built

## The problem

A job is planned against one board. Production does not always get that board.

If a job needs 4,000 sheets of `Saffire · 300 GSM · 23x36` and the warehouse holds
2,500, the plant finishes the job on 290 GSM — or on 290 and 280 together, or on
300 from two different lots. The ERP cannot say this. `order_lines` resolves to
exactly one board through `EFF_BOARD_ID`, and cutting issues it with a single
`consumeFifo` call, so the only ways to record reality today are to edit the
product master for a decision that lasts one job, or to let the ledger lie.

The consequences are not cosmetic. `readiness()` blocks the release with
*"board short by N parent sheets"* counted against the planned board alone, so a
job that is fully covered by three boards cannot be pushed to a job card at all.

## What this is not

The planned board stays the specification. This feature records what was
*consumed*; it never rewrites what was *specified*. The product master is not
touched, `spec_override.board_material_id` keeps its present meaning, and a job
that consumes a substitute still reads as a 300 GSM job everywhere it always did.

## The substitution rule

**Grade is fixed.** A substitute must share the planned board's grade. This is
enforced, not warned — a Saffire job is never offered Duplex GB.
`parseBoardName()` in `server/src/board-code.js` resolves grade, GSM and size
from a board name (`Saffire · 300 GSM · 23x36`) and is already unit-tested, so
the rule has a dependable source. `boardIdentity()` in `routes/orders.js` is
**not** used for this: it takes the first whitespace-delimited word, which reads
`Duplex GB` as `Duplex`.

GSM and size may differ. How much that costs is decided by `childFit()`, which
already exists, and the row is flagged accordingly:

| Difference from the planned board | Conversion | Flag |
| --- | --- | --- |
| GSM only, same sheet size | 1 : 1 | Amber chip, `300 → 290` |
| Sheet size differs, **same ups** | 1 : 1 | Amber chip, "different size, same 6-up, extra trim" |
| Sheet size differs, **ups differ** | through ups | Red-amber, "8-up vs 6-up — needs its own plate layout" |
| Grade differs | — | Not offered |

The same-ups case is the cheap one: a larger sheet trimmed to the same working
area wastes board and nothing else. The different-ups case changes the
imposition and therefore the printing forme, which is expensive, and it must
look expensive on screen.

> **Amendment, made while planning the build.** `job_cards.children_per_parent`
> is an `INTEGER` (`server/src/db.js:243`), and `cuttingVariance()` derives actual
> parents as `round((qty_out + qty_scrap) / children_per_parent)`. A mix whose
> rows have *different* ups has no single integer value there, so every such job
> would report a wrong cutting variance. The ups conversion is therefore built
> and tested in `board-mix.js`, but the UI offers a different-ups row and then
> refuses to save it, naming the reason. A board that changes the imposition
> needs its own plate — it is a different print run, not a substitution.
> Unlocking it later is a UI change plus a job-card column, not a rewrite.

No approval gate. A substitute is the planner's call, recorded in the timeline,
consistent with the strength mix-up alarm and the artwork/output gate — soft
alarm, no hard block.

## Ownership: Planning concretes, Cutting overrides

The planner builds the whole mix in the Planning Engine and the balance must
reach zero before the job can be released. *Released* means the push to a job
card — `createJobCardForLine()`, reached from Planning and from the workflow
route — which is the same gate `readiness()` already guards.

Cutting's default is a single tap — *issue as planned*. When the pile does not
match the paper, or the decision changes on the day, the operator takes an
explicit override path that records what actually went out and why. Planned rows
are never overwritten; the deviation is visible rather than silent. A named lot
that another job has emptied in the meantime arrives at this same path: it is a
stock mismatch, which is exactly what the override is for.

This deliberately reuses the cutting-variance idiom already on the floor: preset
reason, amber styling, no hard block.

## Data model

One new table.

```sql
CREATE TABLE IF NOT EXISTS job_board_mix (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_line_id   INTEGER NOT NULL REFERENCES order_lines(id) ON DELETE CASCADE,
  material_id     INTEGER NOT NULL REFERENCES materials(id),
  stock_batch_id  INTEGER REFERENCES stock_batches(id) ON DELETE SET NULL,
  sheets          DOUBLE PRECISION NOT NULL CHECK (sheets > 0),
  ups             INTEGER NOT NULL CHECK (ups > 0),
  covers          DOUBLE PRECISION NOT NULL CHECK (covers > 0),
  role            TEXT NOT NULL CHECK (role IN ('planned','substitute')),
  phase           TEXT NOT NULL CHECK (phase IN ('plan','issued')),
  reason          TEXT,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fk_job_board_mix_order_line_id ON job_board_mix (order_line_id);
CREATE INDEX IF NOT EXISTS idx_fk_job_board_mix_material_id   ON job_board_mix (material_id);
CREATE INDEX IF NOT EXISTS idx_fk_job_board_mix_stock_batch_id ON job_board_mix (stock_batch_id);
CREATE INDEX IF NOT EXISTS idx_job_board_mix_line_phase ON job_board_mix (order_line_id, phase);
```

- `sheets` — parent sheets of **this** board.
- `ups` — `childFit()` of this board against this job's child sheet, frozen at
  the moment the row was written. Frozen because a later child-size edit must
  not silently re-interpret a plan the planner already balanced.
- `covers` — how much of the planned requirement this row satisfies, in planned-
  board parent sheets. Stored rather than derived so the balance a planner saw
  is the balance that is audited.
- `stock_batch_id` — `NULL` means FIFO, which is the normal case. A named lot
  lets a planner deliberately clear ageing stock.
- `phase` — `plan` rows come from the Planning Engine, `issued` rows from
  Cutting Start. Both survive; nothing is destructively edited.

`reason` is required on `role='substitute'` rows and on any `issued` row that
differs from its plan.

### The contract that keeps the blast radius at zero

**A job with no `job_board_mix` rows behaves exactly as it does today.** Rows are
written only when a planner opens the panel. The moment one row exists the mix is
authoritative for that job and must balance. When the planner adds their first
substitute, the panel seeds the planned-board row with the remainder, so nobody
types the obvious row by hand.

### Mirror into `board_allocations`

Every `phase='plan'` row also writes an ordinary `source='stock'` hold into
`board_allocations`, the same mirror idiom the ERP already runs between PRs and
allocations. The warehouse's free/held view is then correct for the 290 GSM
stock without the live purchase formula being edited. Releasing or re-planning a
mix row releases its hold, and issuing the job flips its holds to `consumed` —
without that flip, `free` drifts permanently low, which is the same trap Task 14
of the board-allocation wave documents.

`phase='issued'` rows never create holds. By the time they exist the board has
left the warehouse.

### When the plan underneath the mix changes

`ups` and `covers` are frozen per row, so a mix is only valid against the cut
plan that produced it. Re-planning the line — a changed child size, order
quantity, wastage, or a different planned board — invalidates every `phase='plan'`
row for that line. Those rows and their holds are cleared and the planner is told
the mix needs rebuilding, rather than being left with a balance that silently no
longer sums. `phase='issued'` rows are historical and are never cleared.

## Coverage maths — `server/src/board-mix.js`

A new pure module beside `board-allocation.js`, following its shape exactly:
plain rows in, numbers out, no `pg`, nothing to mock, heavily unit-tested. These
numbers gate a release, so they get the same treatment as the numbers that decide
purchase quantities.

```
covers  = sheets × row_ups / planned_ups
balance = parent_sheets_required − Σ covers
releasable when |balance| < EPS
```

`EPS = 1e-6`, not `=== 0`. `sheets` and `covers` are `DOUBLE PRECISION`, and an
exact-zero comparison on floats is the trap that already caught the
replenishment code.

`planned_ups` is guarded: a zero or missing value throws rather than dividing,
mirroring how `linePosition` refuses to guess at the line being planned.

Exported surface:

- `rowCovers({ sheets, ups, planned_ups })`
- `mixBalance({ line, rows })` → `{ required, covered, balance, balanced }`
- `substitutionFlags({ planned, candidate, child })` → `{ ok, grade_ok, gsm_delta, size_differs, ups_differ, severity }`
- `mixPosition({ line, rows, materialId })` → what this line holds and needs on a
  given board, feeding `linePosition` without editing it

## Engine touch points

Five, all additive. Each one short-circuits to today's behaviour when the job has
no mix rows.

1. **`readiness()` (`server/src/helpers.js`)** — the "board short by N parent
   sheets" blocker asks the mix when rows exist, and checks each row's own board
   for availability. No rows, identical output.
2. **Board position (`routes/orders.js` planning context, `routes/board.js`)** —
   a job planned on 300 GSM must not begin to look as though it *needs* 4,000
   sheets of the 290 GSM board merely because it is taking 1,500 from it, or the
   290 stock reads as over-committed and drives phantom purchase requests. On a
   substitute board a line contributes a hold and **zero** open need. This is a
   new helper feeding `linePosition`, not an edit to `board-allocation.js`.
3. **Cutting start (`routes/production.js:582`)** — the single
   `consumeFifo(eff.board_material_id, jc.sheets_issued, …)` becomes a loop over
   the job's `issued` rows, consuming each from its own material and honouring a
   named lot where one is set. No rows, the same single call, unchanged.
4. **Plan save (`routes/orders.js` `/order-lines/:id/plan`)** — persist the mix
   rows inside the existing transaction and mirror the holds.
5. **Job card, print and timeline** — show the boards actually consumed.

**Cutting variance needs no change.** It trues up against
`eff.board_material_id`, which remains the planned board, and that stays the
right answer: an over-cut or under-cut is a deviation against the plan.

## User interface

### Planning Engine

The mix panel sits directly under the existing **Board Position** card. The red
*"Short N parent sheets"* banner gains a third button beside the two already
there:

> `Take board from another job` · `Raise PR for 1,500` · **`+ Cover with another board`**

Nothing else on that screen moves. The panel is a small table — board, GSM,
size, lot, free, sheets — with a running **Balance to allocate** that turns green
at zero, and per-row flag chips from `substitutionFlags`. The candidate picker
reuses the existing smart-match ranking, filtered to the planned board's grade.

### Cutting Start

The existing Line Clearance dialog gains a board-issue step listing the planned
rows with the mixed boards named. Confirming is one tap. Editing a quantity or a
lot requires a preset reason, writes `phase='issued'` rows, marks the job
deviated and posts to the timeline.

## Out of scope

- **Gang runs.** A gang shares one board and buys it on a single combined PR.
  Mixing inside a gang is blocked with the same message `planMove` already uses:
  *"prints in gang … — move the gang's board from Planning."*
- **Job-level board costing.** No such figure exists in the ERP today; board
  rates are a master only. This feature makes per-board consumption accurate in
  `stock_movements`, which is what a costing report would read from. No costing
  engine is being invented here.
- **Extra Sheets (CI-XS).** Continues to issue the planned board, as now. If the
  planned board is exhausted the XS request fails as it would today — a known
  limitation, not a regression.
- **Auto-replenishment** of consumed substitute stock. Eating slow-moving stock
  is the point of the feature.

## Testing

- Unit tests on `board-mix.js`: coverage conversion, ups maths, the `EPS`
  balance, the grade rule, same-ups versus different-ups detection, and the
  `planned_ups` guard.
- **Property test — the one that matters:** with zero mix rows, every derived
  number equals the pre-feature value. `board-allocation.test.js` already carries
  this guard for the allocation formula and it is why that change shipped safely.

  > **Amendment, found while building Task 3.** The unit-level property test has
  > a layer it cannot reach. It proves `board-mix.js` returns `null`/inactive for
  > a job with no rows, and cross-checks `linePosition` against an independently
  > recomputed legacy formula. It cannot prove that a *caller* seeing `null`
  > actually falls through to the old path — the two modules have no
  > cross-imports, so that contract lives in integration code that does not exist
  > until the wiring lands. `readiness()` and the planning context must therefore
  > carry their own equivalent assertion at their own layer. That, not the
  > unit-level one, is the assertion this feature's safety actually rests on.
- Integration on a live temp server against PG `:5439`: seed a UAT job, plan a
  two-board mix, confirm the release gate opens only at balance zero, confirm
  cutting start consumes both materials in the right quantities, then drive the
  override path. Clean up by exact captured id, never `LIKE`.
- `npm run verify` from a clean detached worktree at the target SHA, since a
  parallel session's uncommitted files otherwise fail the build.

## Migration

`supabase/migrations/0015_job_board_mix.sql` and
`supabase/migrations/0016_board_allocation_mix_link.sql`.

> **Renumbered during final review, 2026-07-31.** This was originally
> `0014_job_board_mix.sql`, reasoned against `main` ending at `0012` with
> `0013` reserved for the then-unmerged `shade-card-simplification` branch.
> `main` has since moved on: `0013` was taken by that branch as expected, but
> `main` now *also* carries two different `0014` migrations
> (`0014_comms_shell.sql` and `0014_stage_reverse_approver.sql`) — a
> pre-existing collision on `main` itself, not one this branch caused. Adding
> a third `0014` would only have made that worse. Both of this branch's
> migrations are renumbered to `0015`/`0016`, the next free numbers above
> everything currently on `main` (`git ls-tree --name-only origin/main
> supabase/migrations/`). Safe to renumber: both are hand-applied and neither
> has been applied to production.

Anik applies it to prod through the Supabase SQL editor — the Supabase MCP
`apply_migration` is blocked by the permission classifier, so hand over the SQL
rather than retrying the tool.

## Delivery note

Built in the `multi-board-consumption` worktree rather than the main tree.
Another session is mid-flight on `shade-card-simplification` with uncommitted
changes to `server/src/routes/production.js`, which this feature also needs.
