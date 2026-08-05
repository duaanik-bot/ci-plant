# Board Mix — dynamic cuts, per-row leftover banking, honest yield ledger

2026-08-05 · planning engine (single-line + gang/run) · decided with Anik

## The problem

The "Boards we are using" panel crams the board name into ~60px, shows each
row's cuts as a read-only number, refuses outright any board whose cuts differ
from the plan, banks leftover only for the planned board once per line, and
labels child sheets as "Cartons" — off by the product's print-ups (10× on the
screenshot product) from the order quantity it claims to be read against.

Anik's asks: (1) readable board cells, (2) per-row dynamic cuts, (3) per-row
leftover banking ("make 1 cut and bank the leftover"), (4) exact yield math
against order qty.

## Decisions taken (Anik, 2026-08-05)

1. **Cuts fully dynamic per row.** Editable, defaulting to the board's max
   yield, capped at it. A board whose natural cuts differ from the plan saves
   fine. The old refusal — *"a different imposition needs its own plate"* — is
   repealed: the child/print sheet is identical across every row of a mix, so
   the plate never changes. The refusal's real basis was arithmetic
   (`job_cards.children_per_parent` is one integer feeding `cuttingVariance`),
   and that arithmetic moves per-board instead.
2. **Ledger shows both units.** Child sheets AND true cartons
   (sheets × cuts × print-ups), footer read against order qty.
3. **Both screens in one wave.** Single-line engine and gang/run panel.

## The model

### Cuts

`job_board_mix.ups` (INTEGER > 0, exists today) stores the **chosen** cuts.
Default = `childFit(board, child).count` (that board's max). Planner may lower
it; never raise above max (server 409s, client caps). `covers` recomputed with
chosen cuts: `sheets × cuts / plannedCuts` — same `rowCovers`, chosen value in.

`substitutionFlags` keeps grade enforcement and severity labelling, but
`ups_differ` becomes a **warning, never a refusal** — server (orders.js:1358
409 removed) and client (`BoardMix` red block, `gangMixOk` at
Planning.jsx:922-924) together. The "needs its own plate" copy goes; a row
whose cuts differ shows a calm note naming both numbers.

### Leftover per row

Choosing k cuts below max banks the remainder. Strip math generalises
`leftoverStrips` into a pure `chosenStrips(parent, child, k)`:

- children laid row-major in the fit's grid orientation;
- bankable rectangles: the un-cut tail strip `(PL − k·cl) × PW` (single-row
  case, k ≤ nL) plus the under-grid strip `k·cl × (PW − cw)`;
- multi-row grids allow k at whole-column boundaries so remainders stay clean
  rectangles;
- existing rules unchanged: < 3" is waste not stock, mixed/area-basis fits bank
  nothing at their own max (their remainder is spent on the extra cut) but DO
  bank when k is below the plain-grid count;
- k = max on a grid fit banks exactly what `leftoverStrips` banks today.

Twinned client/server (`lib/cutFit.js` ↔ helpers), tested via `node --test`
like every other twin.

### Storage — no DDL

Per-row leftover extends **`order_lines.leftover_plan`** (existing JSON
column), not a new column. Shape v2:

```json
{ "version": 2,
  "rows": [{ "material_id": 12, "cuts": 1, "strip": {"l": 25.34, "w": 24},
              "est_sheets": 417 }] }
```

Legacy shape (`{push, strip, …}`) stays valid for no-mix jobs; readers handle
both. Chosen because the session's standing rule is no prod deploy/migration:
a JSON-shape extension ships without a DDL window. (`job_board_mix` needs no
change — `ups` already holds the chosen value.)

### Banking

Per-row batches `LO-PLAN-<lineId>-<materialId>` via the existing
`bankPlanningLeftover` machinery (master per source-board+strip, movement
ledger, re-plan delta reconciliation, `unbankPlanningLeftover` sweeps all of a
line's batches). Banked at plan lock, confirmed to `LO-<jc>` at cutting
completion, reversed by the existing job-stage reversal paths.

Banking is **opt-in per row** — a reduced-cut row always has a physical strip,
but whether it becomes stock is the planner's call (a damaged strip is waste);
the toggle defaults ON whenever the strip is usable.

Run scope refinement (found in code, 2026-08-05): chosen cuts and leftover
banking apply to **merge runs only** (`gang_runs.kind='merge'` — one product,
one child size, so "k cuts of this board" is one true number). A **gang-kind**
run's cuts are inherently per member-child (`upsFor` recomputes per member at
lock), and `production.js` already deliberately refuses auto-leftover on gang
parents ("mixed child layouts"). Gang-kind runs keep derived, read-only cuts
and no banking; the panel says so instead of hiding it.

Merge runs bank **once per board per run** (the pile is cut once for the whole
run), keyed `LO-PLAN-RUN-<runId>-<materialId>` — never per member, or the
split would bank the same strip N times. `gang_runs` has no JSON column and
gets none: **the batches themselves are the run's record.** Reopening a locked
run seeds the toggles from existing `LO-PLAN-RUN-*` batches; re-lock
reconciles deltas (an untoggled row reconciles its batch to zero) — the same
delta machinery `bankPlanningLeftover` already runs. Strip dims and est
sheets are derived pure from the mix rows (`chosenStrips(board, child, ups)`)
wherever a reader needs them, so the run stores no second copy to drift.

### Cutting variance — per board

At cutting completion with a mix active, the operator reports children **per
board** (the dialog lists each issued pile; the sum is the stage total).
Expected children per board = issued sheets of that board (`phase='issued'`
rows) × that board's chosen cuts; variance judged per board, zero-tolerance as
today, with **one shared reason** per completion (one operator, one event) and
per-board deltas recorded — one `cutting_discrepancies` row per variant board,
each truing up its own board's stock. `production-variance.js` grows the
per-board path beside the single-board one; its test file grows with it.

### The consumer rule

**When a mix is active, every reader of `children_per_parent` derives from the
mix rows; the single integer remains only for no-mix jobs.** 21 files reference
it (JC print, floor, extra sheets, received/boardUsed libs, …) — the
implementation plan enumerates each and classifies: derive-from-mix, unchanged
(single-board path), or display "mixed" where one number is genuinely
unrepresentable. The no-mix path stays byte-identical — the PROPERTY test in
board-mix.test.js already pins this and must keep passing.

### Yield ledger

Row: Board (full width, line 1) · Cuts (editable) · Sheets (editable) ·
Child sheets (derived) · Cartons (derived, × print-ups) · leftover chip
("banks 417 × 25.34×24″") on line 2. Footer: child sheets vs required
(base + wastage from order qty ÷ print-ups), cartons vs **order qty** with
over/under called out. Every displayed number rounds; EPS comparisons, never
`=== 0`.

### UI

Two-line rows fix the visibility ask: line 1 = full-width board select
(name + waste + free never truncated) + PLANNED chip + remove; line 2 = the
numbers. Same grid template shared by header and footer so columns stay
aligned. Gang panel gets the identical component behaviour (it already renders
BoardMix against run totals).

## Smart Match feeds the mix — with consent (added 2026-08-05, Anik)

Smart Match's `Use` today silently **swaps the plan's board** (`pickBoard` —
new board, ctx reload, "lock to confirm"). It becomes a consented action, and
its destination changes by what the board is:

- **Same grade as the planned board** → a popup in the panel's confirm idiom:
  the **master** (planned board, its requirement), **using** (the match, the
  sheets it will take — the remaining shortfall converted by its cuts, capped
  at its available stock), **covers** (child sheets / cartons), **pending**
  (the balance left after). Confirm `Add to the mix` seeds it as a substitute
  row on the left — master row retained, dedup rule honoured (already-in-mix
  boards say so instead of double-seeding) — and the normal flow continues:
  ledger, leftover toggle, lock, floor. Dismiss is `Not now`.
- **Different grade (or unparseable name)** → the mix would 409 it
  (grade is the customer's spec), so `Use` keeps the swap semantics — behind
  its own confirm naming both grades and that the plan re-parents. The
  warehouse picker's full-swap path is untouched either way.

Nothing on Smart Match acts silently any more.

## Verification

Writable sandbox (`cierp_shortage` pattern): plan a mix with reduced cuts,
lock, prove `LO-PLAN-*-*` batches + movements + leftover masters in SQL;
re-plan and prove reconciliation; complete cutting with per-board variance;
gang run seeded end-to-end the same way. Cut-plan screenshot oddity (parent
25×38 "trimmed from" 23×26.5 board — dimensionally impossible) chased during
implementation: stale hint vs missing validation, fixed accordingly.

## Out of scope

- Applying anything to prod (standing rule — local only until sanctioned).
- Guillotine sequencing/nesting beyond clean-rectangle strips.
- Leftover pricing/valuation changes.
