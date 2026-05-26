# Smart Match — Parent-size input (planning engine)

**Date:** 2026-05-26
**Status:** Design — awaiting review
**Area:** `src/components/planning/engine/SectionSmartMatch.tsx`,
`src/lib/smart-match-parent-sheets.ts`, `src/components/planning/engine/types.ts`
(`masterSheetSizes` on readiness), readiness API route (distinct master-size projection)

## Goal

In the Planning Engine's **Smart Match** section, stop asking the planner to type the
**child** sheet size. Instead, derive the child size + cut count from the **Board
Allocation** zone, compute the **parent** sheet size from them, and present it as an
**editable Parent L/W field** that the planner can override.

> Example: child `18 × 23`, cut type `2` → parent `23 × 36`.

The ranked warehouse match list keeps its current behaviour (it ranks every stocked
parent that can produce the child under the cut type). The Parent field is an editable
target that drives a live utilization preview.

## Current behaviour (baseline)

`SectionSmartMatch.tsx` today:
- Local state `childLength`, `childWidth`, `unit`, `cutType`, `requiredQty`.
- `childLength/Width` default from `defaultChildDims(line)` which parses `line.cartonSize`.
- `cutType` defaults to `1`.
- `matches = rankParentSheetMatches({ childLength, childWidth, cutType, requiredQty, unit, board, gsm, candidates })`.
- Renders a "Child L / Child W / Unit / Cut type / Required qty" input row, then the
  ranked `ParentMatchCard` list (or empty states).

`rankParentSheetMatches` (in `smart-match-parent-sheets.ts`) iterates warehouse
candidates and, via `computeEqualDivisionFit`, keeps the parents where the child fits
under an N-equal-division cut. **This matcher is unchanged by this work.**

## Proposed behaviour

### 1. Source child + cut from Board Allocation

Smart Match resolves its inputs from the same line data the Board Allocation zone uses,
not from a separate child entry:

- **Child dims**: `line.sheetSpec.childSize` (parsed via `parseSheetDims`) →
  fallback `line.cartonSize` → fallback `line.carton?.sheetSizeL/W`.
- **Cut type**: `line.sheetSpec.cutType` → fallback `1`.
- **Unit**: `line.sheetSpec.unit` → existing magnitude inference.

Child + cut are **read-only inputs to the computation**. The child is shown as a small
derived sub-label (e.g. "Child 18 × 23 · from Board Allocation"), not an editable field.

**Cut type stays editable** in Smart Match (defaulted from Board Allocation). Changing it
re-computes the default Parent value, consistent with the existing "Try a different cut
type" affordance.

If no child size can be resolved, render a blocking empty state:
"Set the carton size in Board Allocation to compute the parent sheet" — do not guess.

### 2. New: `computeParentFromChild(child, cuts, snapTargets)`

A pure function added to `smart-match-parent-sheets.ts`:

```
computeParentFromChild({
  childLength, childWidth, cutType, unit, snapTargets?: SheetSize[]
}): {
  rawLength, rawWidth,        // squarest geometric tiling
  length, width,              // after snap (== raw if no snap target ≥ raw)
  snappedTo: 'mill' | 'master' | null,  // provenance of the snapped size
  grid: [a, b],               // chosen factor pair
}
```

Algorithm:
1. **Squarest tiling.** For each factor pair `(a, b)` with `a·b = cuts`
   (reuse existing `factorPairs`), candidate parent = `(childL·a) × (childW·b)`.
   Pick the pair minimising aspect ratio `max(L,W)/min(L,W)`. Tie-break: larger
   `min(L,W)`, then deterministic order. → `18×23, 2-cut` yields `36×23` (ratio 1.57)
   over `18×46` (ratio 2.56). Sorted for display: **23×36**. `4-cut → 36×46`,
   `6-cut → 46×54`.
2. **Snap up to a real sheet size.** From `snapTargets` (parsed dims, orientation-aware
   via sorted dims, unit-normalised), pick the smallest entry whose both dimensions are
   `≥` the raw computed parent, minimising extra area. Use it as the default. If none
   qualifies, fall back to the raw computed size. Prefer a `master` size over a `mill`
   size when both tie on area (the planner can buy the master size directly).

### 2a. Snap targets — standard mill sizes ∪ inventory masters

`snapTargets` is the union of two sources, assembled in the component:

- **Standard mill sizes** — a new exported constant `STANDARD_MILL_SHEET_SIZES`
  (inches) in `smart-match-parent-sheets.ts`. Proposed starter set **(confirm/adjust
  during review — these are business data)**:
  `18×23, 18×28, 20×30, 23×36, 25×36, 25×38, 28×36, 28×44, 30×40, 31×43, 33×46, 36×48`.
- **Warehouse inventory masters** — distinct active board sheet sizes from the
  `Inventory` master (`sheetLength × sheetWidth`, `active`, sheet unit). Surfaced as a
  new `masterSheetSizes?: string[]` field on `PlanningEngineReadiness`. The readiness
  route already loads board inventory masters (`inventoryCandidatesAll` in
  `reserve-material` / `po-lines`), so this is a distinct-size projection on data it
  already has — no extra query of scale.

Each target carries a `source: 'mill' | 'master'` tag for the provenance return value.
The in-stock candidate pool is implicitly covered (every stocked size is also a master
size), so it needs no separate source. Unit handling reuses the lib's existing
magnitude inference + `MM_PER_INCH`.

### 3. UI: editable Parent field + live preview

`SectionSmartMatch.tsx` changes:
- Replace `childLength/Width` state with `parentLength/Width` state, defaulted from
  `computeParentFromChild(...)`. Re-derive the default when the resolved child / cut
  type / `snapTargets` change (and the planner hasn't manually edited — track a
  `parentTouched` flag so re-defaults don't clobber an override).
- Input row becomes: **Parent L · Parent W · Unit · Cut type · Required qty**, with the
  derived "Child …" sub-label beneath.
- **Live preview block** for the entered Parent: run `computeEqualDivisionFit({ parent,
  child, cutType })` → pieces/sheet, utilization %, waste %, required parent sheets
  (`ceil(requiredQty / piecesPerSheet)`), and — if a warehouse card matches the entered
  parent size — its free stock + shortage. Recomputes on every Parent / cut / qty edit.
- **Highlight** the warehouse `ParentMatchCard` whose parsed size equals the entered
  parent (orientation-aware), in addition to the existing `selectedMaterialId` ring.

### 4. Matching list — unchanged

`rankParentSheetMatches` still receives the resolved **child** + cut type and ranks all
qualifying warehouse parents. The Parent field does **not** filter this list. This is the
"parents that fit the child / least behaviour change" decision: experimenting with the
Parent value never hides valid stock.

## Edge cases

- **Non-integer child dims** and **mm/inch**: reuse `MM_PER_INCH` + magnitude inference
  already in the lib. `computeParentFromChild` works in the child's own unit; display
  formatting via existing `formatSize`.
- **Orientation**: compare/snap on sorted `(min, max)` dims so `23×36` matches `36×23`.
- **cuts = 1**: parent defaults to the child size itself (1×1 grid), snapped to the
  nearest mill/master size ≥ child.
- **No snap target ≥ raw**: raw computed parent is the default (`snappedTo: null`);
  preview still computes; list shows the existing no-material / no-match empty state.
- **`masterSheetSizes` absent** (older readiness payload): snap against
  `STANDARD_MILL_SHEET_SIZES` only — never break if the API field is missing.
- **Parent edited below child size**: preview shows 0 pieces / 100% waste (the fit
  function already returns `qualifies: false`); surface a gentle "parent smaller than
  child" note rather than an error.

## Testing

`smart-match-parent-sheets.test.ts` (extend):
- `computeParentFromChild`: the `18×23 / 2-cut → 23×36` example; `3/4/6-cut` grids;
  snap picks smallest mill/master size ≥ computed; `master` preferred over `mill` on tie;
  fallback to raw (`snappedTo: null`) when no target fits; empty `snapTargets`; cuts=1;
  mm + inch.

`SectionSmartMatch.test.tsx` (extend):
- Parent field pre-fills from resolved child + cut.
- Editing Parent recomputes the preview (pieces/sheet, waste).
- Changing cut type re-defaults Parent (when untouched) and not (when touched).
- Blocking state when no child resolvable.
- Ranked list still renders independent of the Parent value.

## Out of scope

- Leftover / balance stock lifecycle (already a documented TODO in the lib).
- A settings UI to edit `STANDARD_MILL_SHEET_SIZES` (it ships as a code constant; editable
  later if needed).
- Persisting the chosen parent back onto the carton master / spec (Smart Match remains a
  read + preview surface; Board Allocation owns persistence).
- Changing `rankParentSheetMatches` ranking or the warehouse candidate source.
