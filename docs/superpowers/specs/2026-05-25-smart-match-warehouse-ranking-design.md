# Smart Match — Warehouse-Driven Ranking + Engine Reorder

**Date:** 2026-05-25
**Status:** Design — awaiting review
**Area:** Planning Engine (`src/components/planning/engine`, `src/lib`, planning reserve-material API)

## Summary

Three changes to the existing Planning Engine:

1. **UI reorder** — stack the four engine sections top-to-bottom as
   **UPS & Spec → Board Allocation → Smart Match → Batch Decision** (single
   full-width column).
2. **Smart Match calc/ranking overhaul** — make parent-sheet recommendations
   warehouse-driven with an explicit, fulfillable-first ranking, realistic
   cuts (gripper allowance), a reusable-offcut calculation, a redefined waste
   metric, make-ready in required sheets, and a clean strict/fallback split.
3. **Warehouse Availability — reversible reservation + stock search** — add an
   **Unreserve** action (full + partial release) so reserving is no longer a
   one-way door, and a **local search bar** that looks up *any* warehouse stock
   (not just Smart Match suggestions) so a planner can find and reserve a
   specific material by code, size, lot, location, or supplier.

The engine is **already warehouse-driven** today: the reserve-material API
queries real `db.inventory` rows and only ever scores actual stock — it never
synthesizes theoretical parent sizes. So the "no theoretical suggestions"
requirement is already met. The real work is the ranking philosophy, the four
calc refinements, and tightening the fallback so recommendations contain only
true board-type + GSM matches.

## Goals

- Recommendations ranked by an explicit, auditable priority order.
- Yield % and waste % are distinct, economically meaningful numbers.
- Every recommendation originates from real warehouse stock matching the
  selected board type + GSM. Other stock appears only as clearly-separated
  "compatible alternatives."
- Show the reusable balance/offcut each option leaves.
- Cuts-per-sheet reflects a gripper allowance.
- Required parent sheets include make-ready.
- Reservations are reversible: a planner can unreserve (full or partial) and
  re-reserve without a dead end.
- A planner can search all warehouse stock and reserve a material the Smart
  Match list didn't surface.

## Non-goals

- No changes to the batch/gang suggestion path (`line.smartMatch.suggestions`).
- No new theoretical-size generation. Warehouse stock only.
- No edge-trim or inter-ups gutter allowance yet (gripper only; the geometry
  layer is built to accept them later).
- No PR/procurement workflow changes beyond what ranking requires.
- No **partial reserve** control yet — reserve stays full-requirement; only
  *release* gets a partial control. (Partial reserve can come later.)
- The stock search reserves through the existing select-then-reserve flow; it
  does not introduce a new bulk-reserve or multi-material path.

## Key design decisions (confirmed with stakeholder)

| Decision | Choice |
|---|---|
| Section order | UPS & Spec → Board Allocation → Smart Match → Batch Decision, single full-width column |
| Architecture | Extract a dedicated ranking layer; keep geometry pure |
| Fallback policy | Strict primary + labeled fallback (compatible alternatives shown separately, never mixed) |
| Cutting allowances | Gripper 0.5 (one edge) only; no trim, no gutter. Configurable. |
| Ranking order | **Fulfillable-first**, then yield → waste → reusable offcut → free stock → existing balance stock |
| Waste definition | Unrecoverable scrap = parent − product − *reusable* offcut (not the simple `100 − yield`) |
| Unreserve scope | Full **and** partial release (reuses existing `releasePlanningReservation`) |
| Stock search scope | Server-side across **all** inventory (code, size, GSM, lot, location, supplier); select → reserve via existing flow |

## Architecture

Three layers, clean boundaries:

```
warehouse stock (db.inventory rows, filtered by board type + GSM)
        │
        ▼
[geometry]  sheet-cut-geometry.ts        ← pure: cuts, yield, waste, offcut
        │   (consumed by material-cut-fit.ts → MaterialCutFitOption[])
        ▼
[ranking]   smart-match-ranking.ts       ← pure: fulfillable-first priority,
        │                                   matchScore, recommendationReason
        ▼
[assembly]  reserve-material route        ← strict set vs compatible alternatives
        │
        ▼
[UI]        SectionSmartMatch.tsx          ← ranked cards + separate alternatives
```

### Layer 1 — Geometry (`src/lib/sheet-cut-geometry.ts`, new)

Pure functions, no ranking, no warehouse concepts. Units are whatever the
sheet dimensions use (inches for sizes like 23×36).

```ts
type Allowances = {
  gripper: number   // default 0.5, applied to ONE edge of the parent
  edgeTrim: number  // default 0, all edges
  gutter: number    // default 0, between adjacent ups
}

type CutGeometry = {
  cutsPerSheet: number
  orientation: 'LxW' | 'WxL'
  yieldPct: number          // product area / parent area
  wastePct: number          // (parent − product − reusable offcut) / parent
  balanceSize: string | null  // e.g. "11 x 23", largest leftover rectangle
  balanceLength: number
  balanceWidth: number
  balanceArea: number
  balanceReusable: boolean    // min dim >= reusableMinDim
}

function computeCutGeometry(input: {
  parentLength, parentWidth, reqLength, reqWidth,
  allowances?: Partial<Allowances>,
  reusableMinDim?: number,    // default: min(reqLength, reqWidth)
}): CutGeometry
```

Cut math (per orientation, then pick the larger `cutsPerSheet`):
- Usable parent in each axis = `parent − edgeTrim*2`, and subtract `gripper`
  from one axis (the feed edge).
- `colsCount = floor((usableW + gutter) / (childW + gutter))` (and rows
  likewise). With default gutter 0 this reduces to today's `floor` division,
  minus the gripper.
- `cutsPerSheet = rows * cols`.

Offcut / balance:
- Product block occupies `(cols*childW + (cols-1)*gutter) × (rows*childL + …)`
  inside the usable area.
- The balance is the largest single leftover rectangle: compare the right
  strip (`remainingW × usableL`) and the bottom strip (`usableW × remainingL`)
  and take the larger-area one as `balanceSize`. (Guillotine model — one
  reusable rectangle, not fragmented offcuts.)
- `balanceReusable = min(balanceLength, balanceWidth) >= reusableMinDim`.

Yield/waste:
- `yieldPct = productArea / parentArea * 100`.
- `wastePct = (parentArea − productArea − (balanceReusable ? balanceArea : 0)) / parentArea * 100`.
- So a clean reusable balance is **not** counted as waste; an unusable sliver is.

The existing `resolveCuts` / `resolveWastage` in `production-os-resolvers.ts`
are superseded by `computeCutGeometry` for the cut-fit path. They remain for
any other callers; `material-cut-fit.ts` switches to the new helper.

### Layer 2 — `MaterialCutFitOption` (extend `src/lib/material-cut-fit.ts`)

`buildMaterialCutFitOptions` keeps its signature and warehouse-iteration logic
but:
- Calls `computeCutGeometry` instead of `resolveCuts`/`resolveWastage`.
- Adds `makeReadySheets` to the input; `requiredParentSheets =
  ceil(requiredFinalSheets / cutsPerSheet) + makeReadySheets`.
- Adds fields to `MaterialCutFitOption`: `balanceSize`, `balanceLength`,
  `balanceWidth`, `balanceArea`, `balanceReusable`, `makeReadySheets`.
- **Stops sorting/tagging internally.** Sorting moves to the ranking layer.
  (It may keep a stable secondary identity sort for determinism, but the
  authoritative ordering is the ranking layer's job.)

`requiredFinalSheets` continues to carry the existing child-level wastage
buffer (`baseSheets + wastageSheets` from `resolveRequirementFromLine`).
Make-ready is **new** and added at the parent level. Make-ready value source:
`specOverrides.makeReadySheets` / `planningCore.makeReadySheets` if present,
else config default `0` (opt-in; no surprise inflation).

### Layer 3 — Ranking (`src/lib/smart-match-ranking.ts`, new)

```ts
type RankedMatch = MaterialCutFitOption & {
  matchRank: number
  matchScore: number          // 0–100, display only
  recommendationReason: string
  rankTags: string[]          // 'In Stock' | 'Best Yield' | 'Lowest Waste' |
                              // 'Reusable Balance' | 'Most Available' | 'Existing Balance Stock'
}

function rankParentSheetMatches(
  options: MaterialCutFitOption[],
  ctx: { /* per-option fulfillable flag derived from free vs required */ },
): RankedMatch[]
```

Ordering (fulfillable-first):
1. **Fulfillable** — `status === 'Ready'` (free stock ≥ required parent sheets,
   shortage 0) ranks above Partial/Shortage. This is the promoted "no
   procurement needed" gate.
2. Highest `yieldPct`.
3. Lowest `wastePct` (the redefined unrecoverable waste).
4. Reusable offcut: `balanceReusable` true first, then larger `balanceArea`.
5. Most `freeSheets`.
6. Existing balance stock: `isLeftover` / balance-sourced stock preferred.
7. Final tiebreak: existing `resolveFitScore` (size/GSM fit), then materialCode.

`matchScore` is a normalized 0–100 composite for the UI bar (weighted blend of
yield, low-waste, reusable-balance, in-stock) — **display only**, never the
sort key. `recommendationReason` is composed from the winning factors, e.g.
`"In stock · best yield 98% · clean 11×23 balance"`.

### Layer 4 — Route assembly (`reserve-material/route.ts`)

- Build the **strict** material set (board type + GSM within tolerance) →
  `buildMaterialCutFitOptions` → `rankParentSheetMatches` →
  `suggestedBoardOptions`. This is the only source of ranked recommendations.
- Build the **relaxed** pool (wider GSM, other board types — real stock) →
  `closestAvailableOptions`, excluding any materialIds already in the strict
  set. Always populated when such stock exists, not only when strict is empty.
- Remove the current backfill that merges relaxed pools into
  `suggestedBoardOptions` when strict is empty. When strict is empty,
  `suggestedBoardOptions` is `[]` and the UI shows the empty state + Raise PR;
  alternatives still render separately.
- Pass `makeReadySheets` through to the cut-fit builder.

### Layer 5 — UI (`SectionSmartMatch.tsx`, `PlanningEngineBody.tsx`)

`PlanningEngineBody.tsx`: reorder render to UPS & Spec → Board Allocation →
Smart Match → Batch Decision in a single `space-y-4` full-width stack; update
the layout comment.

`SectionSmartMatch.tsx`:
- Recommendation cards (`suggestedBoardOptions`, top 3) add: balance/offcut
  size with a "Reusable" badge, `matchScore`, and `recommendationReason`.
- New visually distinct **"Compatible alternatives"** block renders
  `closestAvailableOptions` below the recommendations, clearly labeled, never
  mixed into the ranked list.
- Batch-suggestion path (`scored`) unchanged.
- Engine `types.ts` `PlanningEngineBoardOption` gains the new optional fields
  (`balanceSize`, `balanceReusable`, `matchScore`, `recommendationReason`).

## Warehouse Availability — reversible reservation + stock search

The Warehouse Availability zone lives inside `SectionBoardAllocation.tsx` (the
stock bar + Reserve button). Two additions, both backed by code that already
exists at the service layer.

### Unreserve (full + partial)

Backend is already done: `releasePlanningReservation({ materialId, releaseQty,
… })` in `material-readiness-service.ts:947` handles full and partial release,
writes a `planning_release` ledger entry, returns stock to `qtyAvailable`, and
guards full-release once production has started. Only the API route and UI are
missing.

- **API** — extend the existing `POST .../reserve-material` with
  `actionType: 'release'` plus optional `releaseQty` (omitted/0 = full
  release). Calls `releasePlanningReservation`. Validates `releaseQty ≤`
  currently-reserved-for-line. Returns the same readiness payload as reserve so
  the UI refreshes in place. Surfaces the service's full-release guard as a
  user-facing error.
- **UI** (`SectionBoardAllocation.tsx`): when `reservedForLine > 0`, show an
  **Unreserve** button (full release) and a small **partial release** input
  ("Release N sheets" → release that qty). When `reservedForLine === 0`, show
  the existing **Reserve** button. This closes the loop: reserve → unreserve →
  reserve again (the current "already reserved → use Adjust" block no longer
  traps the planner, because release zeroes the reservation).
- **Wiring**: add `onRelease?: (qty?: number) => Promise<void>` alongside the
  existing `onReserve` through `PlanningEngineBody` → the owning drawer
  (`PlanningJobDetailDrawer`), which posts `actionType:'release'`.

Releasing a reservation is a reversible inventory operation (the inverse of
reserve) — not a destructive delete.

### Local stock search (server-side, all inventory)

A search bar in the Warehouse Availability zone that finds **any** active stock,
not just Smart Match suggestions.

- **API** — `GET .../reserve-material/stock-search?q=<term>` (or a query param
  on the existing readiness GET). Queries `db.inventory` (`active: true`) where
  the term matches `materialCode`, `boardType`, `storageLocation`, the size
  string (`sheetLength × sheetWidth`), `gsm`, or the related `supplier.name`;
  lot/traceability is matched from `attributes`. Returns rows shaped like the
  board options (so selection reuses the existing flow), including
  `materialCode`, size, `gsm`, `qtyAvailable`, `qtyReserved`, free, storage
  location, supplier name, and lot (from attributes). Debounced, capped (e.g.
  top 20).
- **UI** (`SectionBoardAllocation.tsx`): a search input; typed queries hit the
  endpoint (debounced); results render as compact selectable rows showing code,
  size, GSM, free/reserved, location, supplier, lot. Selecting a row links it
  as the line's material via the existing `onSelectBoard(materialId)`, after
  which the planner reserves it normally. The search is supplementary — it does
  not replace the ranked recommendations.

### Files

- `material-readiness-service.ts` — reuse existing `releasePlanningReservation`
  (no change expected; add a thin search helper if cleaner).
- `reserve-material/route.ts` — `POST` gains `actionType:'release'` + `releaseQty`;
  add stock-search `GET` (or query param).
- `SectionBoardAllocation.tsx` — Unreserve + partial-release controls; stock
  search input + results list.
- `PlanningEngineBody.tsx`, `PlanningJobDetailDrawer.tsx` — thread `onRelease`
  (and the search call) down.

## Data flow

```
Spec (qty, ups, child size, board type, GSM, wastage%, [makeReady])
  → resolveRequirementFromLine → requiredFinalSheets (= base + wastage)
  → reserve-material GET
      → db.inventory (board+GSM filtered = strict;  relaxed = alternatives)
      → buildMaterialCutFitOptions(requiredFinalSheets, makeReady, allowances)
          → computeCutGeometry per option (cuts, yield, waste, balance)
      → rankParentSheetMatches (fulfillable-first priority)
  → { suggestedBoardOptions: ranked strict, closestAvailableOptions: relaxed }
  → SectionSmartMatch (ranked cards + separate alternatives)
```

## Error handling / edge cases

- Zero/invalid dims or `cutsPerSheet === 0` → option skipped (as today).
- Gripper ≥ parent dimension → `cutsPerSheet` 0 → skipped.
- No strict matches → `suggestedBoardOptions: []`, empty state + Raise PR.
- No stock at all → existing `noMaterialsAtAll` path.
- `balanceArea` 0 / unusable → `balanceReusable false`, counted as waste.
- Make-ready default 0 keeps current required-sheet numbers unless spec sets it.
- Release with `releaseQty >` reserved-for-line → rejected (service throws;
  API maps to a 400 with a clear message).
- Full release after production started → blocked by the existing service guard;
  surfaced as a user-facing error, reservation untouched.
- Stock search: empty/short term → no query; no matches → empty results state;
  selecting a searched material follows the normal reserve validation.

## Testing

- **Geometry unit tests** (`sheet-cut-geometry.test.ts`): cuts with/without
  gripper; orientation choice; offcut size + reusable flag; yield vs
  redefined waste (reusable balance excluded from waste).
- **Ranking unit tests** (`smart-match-ranking.test.ts`): fulfillable-first
  gate dominates yield; each subsequent tiebreak in isolation; `matchScore`
  and `recommendationReason` shape.
- **material-cut-fit**: make-ready added to required parent sheets;
  no internal sort dependency.
- **SectionSmartMatch.test.tsx**: renders balance/score/reason; compatible
  alternatives render in a separate block and never inside recommendations.
- **Reserve/unreserve**: `actionType:'release'` releases full and partial qty,
  rejects over-release, respects the production-started guard; UI shows
  Unreserve when reserved and Reserve when not (round-trip).
- **Stock search**: endpoint matches code/size/gsm/location/supplier/lot;
  selecting a result links the material; debounce + empty states.
- Keep the existing test baseline green.

## Files touched

| File | Change |
|---|---|
| `src/lib/sheet-cut-geometry.ts` | **new** — geometry layer |
| `src/lib/smart-match-ranking.ts` | **new** — ranking layer |
| `src/lib/material-cut-fit.ts` | use geometry; add make-ready + balance fields; drop internal sort |
| `src/lib/production-os-resolvers.ts` | `resolveRequirementFromLine` reads make-ready (optional) |
| `src/app/api/planning/po-lines/[id]/reserve-material/route.ts` | strict-only ranked set; always-on separate alternatives; pass make-ready; `POST actionType:'release'` + `releaseQty`; stock-search `GET` |
| `src/lib/material-readiness-service.ts` | reuse `releasePlanningReservation` (+ thin stock-search helper if cleaner) |
| `src/components/planning/engine/PlanningEngineBody.tsx` | reorder sections; thread `onRelease` + search |
| `src/components/planning/engine/SectionSmartMatch.tsx` | balance/score/reason; compatible-alternatives block |
| `src/components/planning/engine/SectionBoardAllocation.tsx` | Unreserve + partial-release controls; stock-search input + results |
| `src/components/planning/PlanningJobDetailDrawer.tsx` | wire release + search API calls |
| `src/components/planning/engine/types.ts` | new optional board-option fields |
| `*.test.ts(x)` | geometry, ranking, material-cut-fit, SectionSmartMatch, reserve/release, stock-search |
