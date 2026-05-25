# Smart Match Warehouse-Driven Ranking + Engine Reorder + Reversible Reservation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Planning Engine's Smart Match recommend warehouse stock with an explicit fulfillable-first ranking and reusable-offcut awareness, reorder the engine sections, and make reservations reversible with a stock-search bar in the Warehouse Availability zone.

**Architecture:** Extract two pure libraries — `sheet-cut-geometry` (cuts/yield/waste/offcut) and `smart-match-ranking` (priority order) — consumed by the existing `material-cut-fit` builder and the `reserve-material` API. The release backend already exists (`reservation-control` endpoint); we only surface it in the UI. A new `stock-search` endpoint backs the search bar.

**Tech Stack:** TypeScript, Next.js (App Router) API routes, Prisma, React (client components), Vitest + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-05-25-smart-match-warehouse-ranking-design.md`

**Test runner:** `npm test` runs `vitest run`. Single file: `npx vitest run <path>`. Single test: `npx vitest run <path> -t "<name>"`.

---

## File structure

**New files**
- `src/lib/sheet-cut-geometry.ts` — pure geometry: cuts, yield, waste, offcut.
- `src/lib/sheet-cut-geometry.test.ts` — geometry unit tests.
- `src/lib/smart-match-ranking.ts` — pure ranking: fulfillable-first order, matchScore, recommendationReason.
- `src/lib/smart-match-ranking.test.ts` — ranking unit tests.
- `src/app/api/planning/po-lines/[id]/stock-search/route.ts` — server-side inventory search.
- `src/lib/stock-search-match.ts` + `.test.ts` — pure helper that refines search rows (size/lot strings) — unit-testable.

**Modified files**
- `src/lib/material-cut-fit.ts` — use geometry, add make-ready + balance fields, drop internal priority sort.
- `src/lib/production-os-resolvers.ts` — `resolveRequirementFromLine` reads optional make-ready.
- `src/app/api/planning/po-lines/[id]/reserve-material/route.ts` — strict-only ranked recommendations, always-on separate alternatives, pass make-ready.
- `src/components/planning/engine/types.ts` — new optional board-option fields.
- `src/components/planning/engine/SectionSmartMatch.tsx` (+ `.test.tsx`) — balance/score/reason + compatible-alternatives block.
- `src/components/planning/engine/SectionBoardAllocation.tsx` (+ `.test.tsx`) — Unreserve + partial release controls; stock-search input + results.
- `src/components/planning/engine/PlanningEngineBody.tsx` — reorder sections; thread `onRelease` + `onStockSearch`.
- `src/components/planning/PlanningJobDetailDrawer.tsx` — implement `onRelease` (POST reservation-control) and `onStockSearch` (GET stock-search).

---

## PHASE 1 — Smart Match calc/ranking + reorder

### Task 1: Geometry layer — `sheet-cut-geometry.ts`

**Files:**
- Create: `src/lib/sheet-cut-geometry.ts`
- Test: `src/lib/sheet-cut-geometry.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/sheet-cut-geometry.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { computeCutGeometry } from './sheet-cut-geometry'

describe('computeCutGeometry', () => {
  it('perfect fit, no allowances → 100% yield, no balance', () => {
    const g = computeCutGeometry({
      parentLength: 36, parentWidth: 24, reqLength: 18, reqWidth: 12,
      allowances: { gripper: 0, edgeTrim: 0, gutter: 0 },
    })
    expect(g.cutsPerSheet).toBe(4)
    expect(g.orientation).toBe('LxW')
    expect(g.yieldPct).toBe(100)
    expect(g.wastePct).toBe(0)
    expect(g.balanceSize).toBeNull()
    expect(g.balanceReusable).toBe(false)
  })

  it('gripper lowers yield but a reusable balance is excluded from waste', () => {
    const g = computeCutGeometry({
      parentLength: 36, parentWidth: 24, reqLength: 18, reqWidth: 12,
      allowances: { gripper: 0.5, edgeTrim: 0, gutter: 0 },
    })
    expect(g.cutsPerSheet).toBe(2)
    expect(g.yieldPct).toBe(50)
    expect(g.balanceReusable).toBe(true)
    expect(g.balanceSize).toBe('24 x 17.5')
    expect(g.wastePct).toBe(1.39) // (864-432-420)/864*100
  })

  it('a thin sliver is NOT reusable and counts as waste', () => {
    const g = computeCutGeometry({
      parentLength: 38, parentWidth: 25, reqLength: 18, reqWidth: 12,
      allowances: { gripper: 0, edgeTrim: 0, gutter: 0 },
    })
    expect(g.cutsPerSheet).toBe(4)
    expect(g.yieldPct).toBe(90.95)
    expect(g.balanceSize).toBe('25 x 2')
    expect(g.balanceReusable).toBe(false)
    expect(g.wastePct).toBe(9.05)
  })

  it('no fit → zero geometry', () => {
    const g = computeCutGeometry({ parentLength: 10, parentWidth: 10, reqLength: 12, reqWidth: 12 })
    expect(g.cutsPerSheet).toBe(0)
    expect(g.balanceSize).toBeNull()
  })

  it('gripper larger than parent → zero geometry', () => {
    const g = computeCutGeometry({
      parentLength: 0.4, parentWidth: 10, reqLength: 0.2, reqWidth: 0.2,
      allowances: { gripper: 0.5, edgeTrim: 0, gutter: 0 },
    })
    expect(g.cutsPerSheet).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/sheet-cut-geometry.test.ts`
Expected: FAIL — "Failed to resolve import './sheet-cut-geometry'".

- [ ] **Step 3: Implement `sheet-cut-geometry.ts`**

Create `src/lib/sheet-cut-geometry.ts`:

```ts
export type CutAllowances = {
  /** Gripper margin removed from ONE parent edge (the length/feed edge). */
  gripper: number
  /** Trim removed from every edge (subtracted twice per dimension). */
  edgeTrim: number
  /** Gap left between adjacent ups. */
  gutter: number
}

export const DEFAULT_ALLOWANCES: CutAllowances = { gripper: 0.5, edgeTrim: 0, gutter: 0 }

export type CutGeometry = {
  cutsPerSheet: number
  orientation: 'LxW' | 'WxL'
  yieldPct: number
  wastePct: number
  balanceLength: number
  balanceWidth: number
  balanceArea: number
  balanceSize: string | null
  balanceReusable: boolean
}

const EMPTY: CutGeometry = {
  cutsPerSheet: 0, orientation: 'LxW', yieldPct: 0, wastePct: 0,
  balanceLength: 0, balanceWidth: 0, balanceArea: 0, balanceSize: null, balanceReusable: false,
}

function pos(v: unknown): number {
  const x = Number(v)
  return Number.isFinite(x) && x > 0 ? x : 0
}

function round2(x: number): number {
  return Number(x.toFixed(2))
}

function fmtDim(x: number): string {
  const r = round2(x)
  return Number.isInteger(r) ? String(r) : String(r)
}

/** How many `piece`-wide cuts fit along `usable`, leaving `gutter` between them. */
function fitCount(usable: number, piece: number, gutter: number): number {
  if (piece <= 0 || usable < piece) return 0
  return Math.floor((usable + gutter) / (piece + gutter))
}

export function computeCutGeometry(input: {
  parentLength: number
  parentWidth: number
  reqLength: number
  reqWidth: number
  allowances?: Partial<CutAllowances>
  /** Min side length for a balance offcut to count as reusable. Default = smaller child dim. */
  reusableMinDim?: number
}): CutGeometry {
  const parentL = pos(input.parentLength)
  const parentW = pos(input.parentWidth)
  const reqL = pos(input.reqLength)
  const reqW = pos(input.reqWidth)
  if (!parentL || !parentW || !reqL || !reqW) return EMPTY

  const a: CutAllowances = { ...DEFAULT_ALLOWANCES, ...(input.allowances || {}) }
  const reusableMinDim = input.reusableMinDim ?? Math.min(reqL, reqW)

  const usableL = parentL - a.gripper - 2 * a.edgeTrim
  const usableW = parentW - 2 * a.edgeTrim
  if (usableL <= 0 || usableW <= 0) return EMPTY

  // Orientation A: reqL along usableL, reqW along usableW. B: rotated.
  const colsA = fitCount(usableL, reqL, a.gutter)
  const rowsA = fitCount(usableW, reqW, a.gutter)
  const cutsA = colsA * rowsA
  const colsB = fitCount(usableL, reqW, a.gutter)
  const rowsB = fitCount(usableW, reqL, a.gutter)
  const cutsB = colsB * rowsB

  const useA = cutsA >= cutsB
  const cutsPerSheet = Math.max(cutsA, cutsB)
  if (cutsPerSheet <= 0) return EMPTY

  const pieceL = useA ? reqL : reqW
  const pieceW = useA ? reqW : reqL
  const cols = useA ? colsA : colsB
  const rows = useA ? rowsA : rowsB

  const usedL = cols * pieceL + (cols - 1) * a.gutter
  const usedW = rows * pieceW + (rows - 1) * a.gutter
  const remL = Math.max(0, usableL - usedL)
  const remW = Math.max(0, usableW - usedW)

  // Guillotine: keep the single larger leftover rectangle.
  const rightArea = remL * usableW
  const bottomArea = usableL * remW
  let bL = 0
  let bW = 0
  if (rightArea >= bottomArea && rightArea > 0) {
    bL = Math.max(remL, usableW)
    bW = Math.min(remL, usableW)
  } else if (bottomArea > 0) {
    bL = Math.max(usableL, remW)
    bW = Math.min(usableL, remW)
  }
  const balanceArea = bL * bW
  const balanceReusable = bL > 0 && bW > 0 && Math.min(bL, bW) >= reusableMinDim

  const parentArea = parentL * parentW
  const productArea = reqL * reqW * cutsPerSheet
  const recoverable = balanceReusable ? balanceArea : 0

  return {
    cutsPerSheet,
    orientation: useA ? 'LxW' : 'WxL',
    yieldPct: round2((productArea / parentArea) * 100),
    wastePct: round2(Math.max(0, ((parentArea - productArea - recoverable) / parentArea) * 100)),
    balanceLength: round2(bL),
    balanceWidth: round2(bW),
    balanceArea: round2(balanceArea),
    balanceSize: balanceArea > 0 ? `${fmtDim(bL)} x ${fmtDim(bW)}` : null,
    balanceReusable,
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/sheet-cut-geometry.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/sheet-cut-geometry.ts src/lib/sheet-cut-geometry.test.ts
git commit -m "feat(planning): add sheet-cut-geometry (cuts, yield, waste, reusable offcut)"
```

---

### Task 2: Ranking layer — `smart-match-ranking.ts`

**Files:**
- Create: `src/lib/smart-match-ranking.ts`
- Test: `src/lib/smart-match-ranking.test.ts`

This task depends on the `MaterialCutFitOption` shape. It uses a structural subset, so it can be built before Task 3 extends that type. Define a local `RankableOption` so the ranker has no hard import cycle.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/smart-match-ranking.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { rankParentSheetMatches, type RankableOption } from './smart-match-ranking'

function opt(over: Partial<RankableOption>): RankableOption {
  return {
    materialId: over.materialId ?? Math.random().toString(36).slice(2),
    materialCode: 'C', status: 'Ready', yieldPct: 90, wastePct: 5,
    balanceReusable: false, balanceArea: 0, balanceSize: null,
    freeSheets: 1000, isLeftover: false, fitScore: 50, ...over,
  }
}

describe('rankParentSheetMatches', () => {
  it('ranks a fulfillable option above a higher-yield shortage option', () => {
    const ranked = rankParentSheetMatches([
      opt({ materialId: 'hi', yieldPct: 98, status: 'Shortage' }),
      opt({ materialId: 'ok', yieldPct: 90, status: 'Ready' }),
    ])
    expect(ranked[0].materialId).toBe('ok')
    expect(ranked[0].matchRank).toBe(1)
  })

  it('among fulfillable, higher yield wins', () => {
    const ranked = rankParentSheetMatches([
      opt({ materialId: 'a', yieldPct: 90, status: 'Ready' }),
      opt({ materialId: 'b', yieldPct: 95, status: 'Ready' }),
    ])
    expect(ranked[0].materialId).toBe('b')
  })

  it('equal yield → lower waste (reusable balance) wins', () => {
    const ranked = rankParentSheetMatches([
      opt({ materialId: 'sliver', yieldPct: 90, wastePct: 8, balanceReusable: false }),
      opt({ materialId: 'reuse', yieldPct: 90, wastePct: 2, balanceReusable: true, balanceArea: 400 }),
    ])
    expect(ranked[0].materialId).toBe('reuse')
  })

  it('equal yield+waste → more free stock wins', () => {
    const ranked = rankParentSheetMatches([
      opt({ materialId: 'low', yieldPct: 90, wastePct: 5, freeSheets: 500 }),
      opt({ materialId: 'high', yieldPct: 90, wastePct: 5, freeSheets: 9000 }),
    ])
    expect(ranked[0].materialId).toBe('high')
  })

  it('emits a 0-100 score and an in-stock reason', () => {
    const ranked = rankParentSheetMatches([opt({ status: 'Ready', yieldPct: 97, balanceReusable: true, balanceSize: '11 x 25' })])
    expect(ranked[0].matchScore).toBeGreaterThanOrEqual(0)
    expect(ranked[0].matchScore).toBeLessThanOrEqual(100)
    expect(ranked[0].recommendationReason).toMatch(/In stock/)
    expect(ranked[0].recommendationReason).toMatch(/97/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/smart-match-ranking.test.ts`
Expected: FAIL — cannot resolve `./smart-match-ranking`.

- [ ] **Step 3: Implement `smart-match-ranking.ts`**

Create `src/lib/smart-match-ranking.ts`:

```ts
export type RankableOption = {
  materialId: string
  materialCode: string
  status: 'Ready' | 'Partial' | 'Shortage'
  yieldPct: number
  wastePct: number
  balanceReusable: boolean
  balanceArea: number
  balanceSize: string | null
  freeSheets: number
  isLeftover: boolean
  fitScore: number
}

export type RankedMatch<T extends RankableOption = RankableOption> = T & {
  matchRank: number
  matchScore: number
  recommendationReason: string
}

function isFulfillable(o: RankableOption): boolean {
  return o.status === 'Ready'
}

function compare(a: RankableOption, b: RankableOption): number {
  // 1. fulfillable first (no procurement needed)
  const fa = isFulfillable(a) ? 1 : 0
  const fb = isFulfillable(b) ? 1 : 0
  if (fa !== fb) return fb - fa
  // 2. highest yield
  if (a.yieldPct !== b.yieldPct) return b.yieldPct - a.yieldPct
  // 3. lowest (unrecoverable) waste
  if (a.wastePct !== b.wastePct) return a.wastePct - b.wastePct
  // 4. reusable offcut, then larger reusable area
  const ra = a.balanceReusable ? 1 : 0
  const rb = b.balanceReusable ? 1 : 0
  if (ra !== rb) return rb - ra
  if (a.balanceReusable && b.balanceReusable && a.balanceArea !== b.balanceArea) return b.balanceArea - a.balanceArea
  // 5. most free stock
  if (a.freeSheets !== b.freeSheets) return b.freeSheets - a.freeSheets
  // 6. prefer existing balance/leftover stock
  const la = a.isLeftover ? 1 : 0
  const lb = b.isLeftover ? 1 : 0
  if (la !== lb) return lb - la
  // 7. final tiebreak: size/gsm fit, then code
  if (a.fitScore !== b.fitScore) return b.fitScore - a.fitScore
  return a.materialCode.localeCompare(b.materialCode)
}

function clamp(x: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, x))
}

function scoreOf(o: RankableOption): number {
  const inStock = o.status === 'Ready' ? 100 : o.status === 'Partial' ? 50 : 0
  const reuse = o.balanceReusable ? 100 : 0
  const raw = 0.35 * o.yieldPct + 0.25 * (100 - o.wastePct) + 0.25 * inStock + 0.15 * reuse
  return Math.round(clamp(raw))
}

function reasonOf(o: RankableOption): string {
  const parts: string[] = []
  if (o.status === 'Ready') parts.push('In stock')
  else if (o.status === 'Partial') parts.push('Partial — raise PR')
  else parts.push('Out of stock — raise PR')
  parts.push(`yield ${o.yieldPct}%`)
  if (o.balanceReusable && o.balanceSize) parts.push(`reusable ${o.balanceSize} balance`)
  if (o.isLeftover) parts.push('uses balance stock')
  return parts.join(' · ')
}

export function rankParentSheetMatches<T extends RankableOption>(options: T[]): RankedMatch<T>[] {
  return [...options]
    .sort(compare)
    .map((o, idx) => ({ ...o, matchRank: idx + 1, matchScore: scoreOf(o), recommendationReason: reasonOf(o) }))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/smart-match-ranking.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/smart-match-ranking.ts src/lib/smart-match-ranking.test.ts
git commit -m "feat(planning): add fulfillable-first smart-match ranking layer"
```

---

### Task 3: Wire geometry + make-ready + balance into `material-cut-fit.ts`

**Files:**
- Modify: `src/lib/material-cut-fit.ts`
- Test: `src/lib/material-cut-fit.test.ts` (create)

- [ ] **Step 1: Write the failing tests**

Create `src/lib/material-cut-fit.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildMaterialCutFitOptions } from './material-cut-fit'

const baseMaterial = {
  materialId: 'm1', materialCode: 'C-1', boardType: 'CYBER', boardClassification: null,
  gsm: 280, availableParentSheets: 9000, reservedParentSheets: 0,
  parentLength: 36, parentWidth: 24,
}

describe('buildMaterialCutFitOptions', () => {
  it('exposes balance fields from geometry', () => {
    const [opt] = buildMaterialCutFitOptions({
      requiredLength: 18, requiredWidth: 12, requiredFinalSheets: 100, requiredGsm: 280,
      config: { allowRotation: true },
      materials: [baseMaterial],
    })
    expect(opt).toBeTruthy()
    expect(opt.balanceSize).toBeDefined()
    expect(typeof opt.balanceReusable).toBe('boolean')
  })

  it('adds make-ready to required parent sheets', () => {
    const [withMr] = buildMaterialCutFitOptions({
      requiredLength: 18, requiredWidth: 12, requiredFinalSheets: 100, requiredGsm: 280,
      makeReadySheets: 50, materials: [baseMaterial],
    })
    const [withoutMr] = buildMaterialCutFitOptions({
      requiredLength: 18, requiredWidth: 12, requiredFinalSheets: 100, requiredGsm: 280,
      makeReadySheets: 0, materials: [baseMaterial],
    })
    expect(withMr.requiredParentSheets).toBe(withoutMr.requiredParentSheets + 50)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/material-cut-fit.test.ts`
Expected: FAIL — `balanceSize`/`makeReadySheets` not present.

- [ ] **Step 3: Edit `material-cut-fit.ts`**

3a. Add the geometry import at the top (keep the existing `production-os-resolvers` import for `resolveFitScore`):

```ts
import { resolveFitScore } from '@/lib/production-os-resolvers'
import { computeCutGeometry } from '@/lib/sheet-cut-geometry'
```
(Remove `resolveCuts, resolveWastage` from that import — they are replaced by `computeCutGeometry`.)

3b. Add balance fields to the `MaterialCutFitOption` type (after `usableAreaPct: number`):

```ts
  balanceLength: number
  balanceWidth: number
  balanceArea: number
  balanceSize: string | null
  balanceReusable: boolean
  makeReadySheets: number
```

3c. Add `makeReadySheets` to the function input signature of `buildMaterialCutFitOptions`:

```ts
export function buildMaterialCutFitOptions(input: {
  requiredLength: number
  requiredWidth: number
  requiredFinalSheets: number
  requiredGsm: number | null
  makeReadySheets?: number
  config?: Partial<MaterialCutFitConfig>
  materials: MaterialCutFitOptionInput[]
}): MaterialCutFitOption[] {
```

And near the top of the body:

```ts
  const makeReadySheets = Math.max(0, Math.floor(n(input.makeReadySheets ?? 0)))
```

3d. Replace the cuts + wastage computation. Find the block that calls `calculateBestCutsWithOrientation`, the `directMode`/`cutsPerSheet` logic, and the `resolveWastage` call, and replace the geometry parts with `computeCutGeometry`. Keep the direct-size / gsm-tolerance classification (it drives `matchType` and `fitScore`). Concretely, after `directMode` is computed:

```ts
    const geo = computeCutGeometry({
      parentLength,
      parentWidth,
      reqLength,
      reqWidth,
      allowances: { gripper: 0.5, edgeTrim: 0, gutter: 0 },
    })
    const cutsPerSheet = directMode === 'none' ? geo.cutsPerSheet : 1
    if (cutsPerSheet <= 0) continue
```

Then replace the `resolveWastage(...)` block and its destructure with values from `geo`:

```ts
    const yieldPct = geo.yieldPct
    const wastagePct = geo.wastePct
    const usableAreaPct = yieldPct
    const sizeDiff = Math.abs(parentLength * parentWidth - reqLength * reqWidth * cutsPerSheet)
    const sizeDeviationPct =
      parentLength * parentWidth > 0
        ? Number(((sizeDiff / (parentLength * parentWidth)) * 100).toFixed(2))
        : 100
```

3e. Update `requiredParentSheets` to add make-ready:

```ts
    const requiredParentSheets = Math.max(1, Math.ceil(requiredFinalSheets / cutsPerSheet)) + makeReadySheets
```

3f. In the `options.push({ ... })` object add the new fields (alongside `wastagePct`, `yieldPct`):

```ts
      balanceLength: geo.balanceLength,
      balanceWidth: geo.balanceWidth,
      balanceArea: geo.balanceArea,
      balanceSize: geo.balanceSize,
      balanceReusable: geo.balanceReusable,
      makeReadySheets,
```

3g. Remove the priority `options.sort(...)` block (the long comparator). Replace it with a deterministic identity sort so `maxSuggestions` slicing is stable — authoritative ordering now happens in the ranking layer:

```ts
  options.sort((a, b) => a.materialCode.localeCompare(b.materialCode))
```

Leave the tag-assignment block (`Best Yield`, `Lowest Wastage`, etc.) as-is — tags remain informational hints.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/material-cut-fit.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the geometry + ranking + cut-fit suite together**

Run: `npx vitest run src/lib/sheet-cut-geometry.test.ts src/lib/smart-match-ranking.test.ts src/lib/material-cut-fit.test.ts`
Expected: PASS (all).

- [ ] **Step 6: Commit**

```bash
git add src/lib/material-cut-fit.ts src/lib/material-cut-fit.test.ts
git commit -m "feat(planning): cut-fit uses geometry layer, adds balance + make-ready, drops internal sort"
```

---

### Task 4: `resolveRequirementFromLine` reads optional make-ready

**Files:**
- Modify: `src/lib/production-os-resolvers.ts` (in `resolveRequirementFromLine`, near `wastage` computation around line 386-429)
- Test: `src/lib/production-os-resolvers.makeready.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/lib/production-os-resolvers.makeready.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { resolveRequirementFromLine } from './production-os-resolvers'

describe('resolveRequirementFromLine makeReadySheets', () => {
  it('defaults makeReadySheets to 0', () => {
    const r = resolveRequirementFromLine({ line: { quantity: 1000, spec: { ups: 2 } } })
    expect(r.makeReadySheets).toBe(0)
  })

  it('reads makeReadySheets from planningCore', () => {
    const r = resolveRequirementFromLine({
      line: { quantity: 1000, specOverrides: { planningCore: { ups: 2, makeReadySheets: 120 } } },
    })
    expect(r.makeReadySheets).toBe(120)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/production-os-resolvers.makeready.test.ts`
Expected: FAIL — `makeReadySheets` undefined.

- [ ] **Step 3: Edit `resolveRequirementFromLine`**

Before the `return { ... }` (around line 421), add:

```ts
  const makeReadySheets = Math.max(
    0,
    Math.floor(
      Number(
        specOverrides.makeReadySheets ??
          planningCore.makeReadySheets ??
          spec.makeReadySheets ??
          specOverridesMeta.makeReadySheets ??
          specMeta.makeReadySheets ??
          0,
      ) || 0,
    ),
  )
```

Add `makeReadySheets` to the returned object:

```ts
  return {
    qty,
    ups,
    wastageSheets: wastage,
    makeReadySheets,
    baseSheets,
    requiredSheets: Math.max(1, baseSheets + wastage),
    sheetSize: resolveSheetSize(line),
    sheetSizePair: parseSheetSizeToPair(resolveSheetSize(line)),
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/production-os-resolvers.makeready.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/production-os-resolvers.ts src/lib/production-os-resolvers.makeready.test.ts
git commit -m "feat(planning): resolveRequirementFromLine reads optional make-ready sheets"
```

---

### Task 5: Route — strict-only ranked recommendations + always-on alternatives

**Files:**
- Modify: `src/app/api/planning/po-lines/[id]/reserve-material/route.ts` (GET handler, lines ~371-461 and the `resolveRequirementFromLine` usage ~278-288)

No new unit test (the route needs DB context); verify by composition — Tasks 1-4 covered the logic. Verify with typecheck + the full suite.

- [ ] **Step 1: Import the ranking layer**

At the top of the route, add:

```ts
import { rankParentSheetMatches } from '@/lib/smart-match-ranking'
```

- [ ] **Step 2: Pass make-ready into the cut-fit calls**

After `const requirementFromLine = resolveRequirementFromLine({ ... })` (around line 278) add:

```ts
  const makeReadySheets = requirementFromLine.makeReadySheets
```

In each of the five `buildMaterialCutFitOptions({ ... })` calls (lines ~372-419), add `makeReadySheets,` to the argument object (next to `requiredGsm`).

- [ ] **Step 3: Make `suggestedBoardOptions` strict-only + ranked; alternatives always-on**

Replace the assembly block (the `byId` map through `closestAvailableOptions`, lines ~421-502) with:

```ts
  // STRICT recommendations: board type + GSM matches only, ranked fulfillable-first.
  const rankedStrict = rankParentSheetMatches(strictSuggestions)

  const withBoardMatchMode = (opt: (typeof rankedStrict)[number]) => {
    const reqType = normalizeText(auto.boardTypeRaw)
    const reqClass = normalizeText(auto.boardClassificationRaw)
    const matType = normalizeText(opt.boardType)
    const matClass = normalizeText(opt.boardClassification)
    const isTypeExact = !!reqType && matType === reqType
    const isTypeViaClass = !!reqType && matClass === reqType
    const isClassViaType = !!reqClass && matType === reqClass
    const isClassExact = !!reqClass && matClass === reqClass
    const boardMatchMode =
      isTypeExact || isClassExact ? 'exact' : isTypeViaClass || isClassViaType ? 'cross_field' : 'fallback'
    const derivedMatchType =
      boardMatchMode === 'fallback'
        ? 'Fallback Option'
        : opt.matchType === 'Cut Fit' && !(opt.isExactSize || opt.isNearSize)
          ? 'Compatible Size'
          : opt.matchType
    return { ...opt, boardMatchMode, matchType: derivedMatchType }
  }

  const suggestedBoardOptionsWithMode = rankedStrict
    .map(withBoardMatchMode)
    .map((opt, idx) => ({ ...opt, matchRank: idx + 1 }))

  // COMPATIBLE ALTERNATIVES: real stock from relaxed pools, excluding the strict set. Always surfaced.
  const strictIds = new Set(rankedStrict.map((o) => o.materialId))
  const closestAvailableOptions = mergeSuggestionPools(
    [relaxedNoClassSuggestions, widerToleranceSuggestions, noBoardGsmSuggestions, noBoardWiderSuggestions],
    10,
  )
    .filter((o) => !strictIds.has(o.materialId))
    .map((o) => withBoardMatchMode({ ...o, tags: Array.from(new Set([...(o.tags || []), 'Compatible Size' as const])) }))
    .map((o, idx) => ({ ...o, matchRank: idx + 1 }))
```

Note: keep the existing `mergeSuggestionPools` helper. Remove the now-dead `byId` map and the old `suggestedBoardOptions`/`fallbackMergedSuggestions` variables. Update `debug.finalSuggestions` to `suggestedBoardOptionsWithMode.length` and the `debugMessage` ternary (line ~606) to test `suggestedBoardOptionsWithMode.length === 0`.

- [ ] **Step 4: Keep the response keys**

The JSON response (lines ~600-601) already returns `suggestedBoardOptions: suggestedBoardOptionsWithMode` and `closestAvailableOptions`. Leave those keys; they now carry `matchScore`, `recommendationReason`, and balance fields from the ranker/geometry.

- [ ] **Step 5: Typecheck + full suite**

Run: `npm run typecheck`
Expected: no errors in the route or libs.
Run: `npx vitest run src/lib`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add "src/app/api/planning/po-lines/[id]/reserve-material/route.ts"
git commit -m "feat(planning): strict-only ranked board recommendations + always-on compatible alternatives"
```

---

### Task 6: Smart Match UI — balance/score/reason + compatible-alternatives block

**Files:**
- Modify: `src/components/planning/engine/types.ts`
- Modify: `src/components/planning/engine/SectionSmartMatch.tsx`
- Test: `src/components/planning/engine/SectionSmartMatch.test.tsx` (extend)

- [ ] **Step 1: Extend the board-option type**

In `types.ts`, add to `PlanningEngineBoardOption` (optional, so existing data still type-checks):

```ts
  balanceSize?: string | null
  balanceReusable?: boolean
  matchScore?: number
  recommendationReason?: string
```

- [ ] **Step 2: Write the failing UI test**

Append to `SectionSmartMatch.test.tsx`:

```ts
  it('renders balance, match score and reason on a board option', () => {
    const r: PlanningEngineReadiness = {
      ...readiness,
      suggestedBoardOptions: [
        {
          materialId: 'b1', materialCode: 'C-1', boardType: 'CYBER', gsm: 280, size: '36 x 24',
          matchType: 'Direct Size', status: 'Ready', freeSheets: 9200, requiredParentSheets: 8650,
          shortageParentSheets: 0, cutsPerSheet: 6, yieldPct: 97, wastagePct: 3, tags: [],
          gsmDelta: 0, balanceSize: '11 x 25', balanceReusable: true, matchScore: 95,
          recommendationReason: 'In stock · yield 97% · reusable 11 x 25 balance',
        } as never,
      ],
    } as PlanningEngineReadiness
    const noScored = { ...baseLine, smartMatch: undefined } as unknown as PlanningEngineLine
    render(<SectionSmartMatch line={noScored} readiness={r} onPatch={async () => true} />)
    expect(screen.getByText('95')).toBeInTheDocument()
    expect(screen.getByText(/reusable 11 x 25 balance/)).toBeInTheDocument()
    expect(screen.getByText('11 x 25')).toBeInTheDocument()
  })

  it('renders compatible alternatives in a separate labelled block', () => {
    const r: PlanningEngineReadiness = {
      ...readiness,
      suggestedBoardOptions: [],
      closestAvailableOptions: [
        {
          materialId: 'alt1', materialCode: 'ALT-1', boardType: 'FBB', gsm: 300, size: '24 x 36',
          matchType: 'Compatible Size', status: 'Ready', freeSheets: 5200, requiredParentSheets: 8650,
          shortageParentSheets: 0, cutsPerSheet: 6, yieldPct: 95, wastagePct: 5, tags: [], gsmDelta: 20,
        } as never,
      ],
    } as PlanningEngineReadiness
    const noScored = { ...baseLine, smartMatch: undefined } as unknown as PlanningEngineLine
    render(<SectionSmartMatch line={noScored} readiness={r} onPatch={async () => true} />)
    expect(screen.getByText(/Compatible alternatives/i)).toBeInTheDocument()
    expect(screen.getByText('ALT-1')).toBeInTheDocument()
  })
```

- [ ] **Step 2b: Run test to verify it fails**

Run: `npx vitest run src/components/planning/engine/SectionSmartMatch.test.tsx`
Expected: FAIL — score/reason/alternatives not rendered.

- [ ] **Step 3: Render balance + score + reason in `BoardOptionCard`**

In `SectionSmartMatch.tsx`, inside `BoardOptionCard`, after the yield/no-waste `grid` (line ~216), add:

```tsx
      {opt.balanceSize ? (
        <div className="mt-2 flex items-center gap-2 text-[11px]">
          <span className="text-ds-ink-faint">Balance</span>
          <span className="font-semibold text-ds-ink tabular-nums">{opt.balanceSize}</span>
          <span
            className={`rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
              opt.balanceReusable
                ? 'border-emerald-500/30 bg-emerald-500/15 text-emerald-300'
                : 'border-ds-line/40 bg-ds-elevated text-ds-ink-faint'
            }`}
          >
            {opt.balanceReusable ? 'Reusable' : 'Sliver'}
          </span>
        </div>
      ) : null}

      {opt.matchScore != null || opt.recommendationReason ? (
        <div className="mt-2 flex items-center justify-between gap-2 border-t border-ds-line/40 pt-2">
          <span className="text-[11px] text-ds-ink-muted leading-tight">{opt.recommendationReason ?? ''}</span>
          {opt.matchScore != null ? (
            <span className="shrink-0 text-sm font-bold tabular-nums text-emerald-300">
              {Math.round(opt.matchScore)}
            </span>
          ) : null}
        </div>
      ) : null}
```

- [ ] **Step 4: Add the compatible-alternatives block**

In `SectionSmartMatch.tsx`, the component currently shows `boardOptions` from a memo that merges strict + fallback. Change it so the ranked recommendations use only `suggestedBoardOptions`, and alternatives render separately. Replace the `boardOptions`/`usingFallback` memos (lines ~246-257) with:

```tsx
  const recommendations = useMemo(() => readiness?.suggestedBoardOptions ?? [], [readiness])
  const alternatives = useMemo(() => readiness?.closestAvailableOptions ?? [], [readiness])
```

Update the render branch (the `boardOptions.length > 0 ?` ternary, lines ~324-338) to iterate `recommendations`, and after the recommendations grid / empty-state, append:

```tsx
      {alternatives.length > 0 ? (
        <div className="mt-5 border-t border-dashed border-ds-line pt-4">
          <div className="mb-1 flex items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint">
              Compatible alternatives
            </span>
            <span className="rounded-full border border-amber-500/30 bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase text-amber-300">
              not board+gsm match
            </span>
          </div>
          <p className="mb-3 text-xs text-ds-ink-faint">
            Real stock that doesn’t match the selected board type / GSM — never mixed into the ranked recommendations.
          </p>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {alternatives.slice(0, 4).map((opt, idx) => (
              <BoardOptionCard
                key={opt.materialId || `${opt.materialCode}-alt-${idx}`}
                opt={opt}
                rank={idx + 1}
                selected={!!selectedMaterialId && opt.materialId === selectedMaterialId}
                onSelect={onSelectBoard ? handleSelect : undefined}
              />
            ))}
          </div>
        </div>
      ) : null}
```

Also update the header count text (line ~271-278) to use `recommendations.length` instead of `boardOptions.length`, and drop the `usingFallback` reference.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/components/planning/engine/SectionSmartMatch.test.tsx`
Expected: PASS (existing + 2 new).

- [ ] **Step 6: Commit**

```bash
git add src/components/planning/engine/types.ts src/components/planning/engine/SectionSmartMatch.tsx src/components/planning/engine/SectionSmartMatch.test.tsx
git commit -m "feat(planning): Smart Match shows balance/score/reason + separate compatible alternatives"
```

---

### Task 7: Reorder engine sections

**Files:**
- Modify: `src/components/planning/engine/PlanningEngineBody.tsx`
- Test: `src/components/planning/engine/PlanningEngineBody.test.tsx` (create)

- [ ] **Step 1: Write the failing test**

Create `src/components/planning/engine/PlanningEngineBody.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { PlanningEngineBody } from './PlanningEngineBody'
import type { PlanningEngineLine } from './types'

const line = {
  id: 'L1', quantity: 1000, specOverrides: null, planningStatus: 'planning',
  po: { id: 'PO1', poNumber: 'PO1', poDate: '2026-05-10', customer: { id: 'C1', name: 'X' } },
} as unknown as PlanningEngineLine

describe('PlanningEngineBody order', () => {
  it('renders sections in order: UPS & Spec → Board → Smart Match → Batch', () => {
    render(
      <PlanningEngineBody
        line={line} readiness={null} readinessLoading={false}
        onPatch={async () => true} onLock={async () => {}}
      />,
    )
    const titles = screen.getAllByText(/UPS & SHEET SPEC|BOARD ALLOCATION|SMART MATCH|BATCH DECISION/i)
      .map((el) => el.textContent?.toUpperCase())
    const idx = (frag: string) => titles.findIndex((t) => t?.includes(frag))
    expect(idx('UPS')).toBeLessThan(idx('BOARD'))
    expect(idx('BOARD')).toBeLessThan(idx('SMART'))
    expect(idx('SMART')).toBeLessThan(idx('BATCH'))
  })
})
```

(If the actual `CardSection` titles differ, adjust the regex to the real titles — confirm by reading `SectionUpsAndSpec.tsx` / `SectionBatchDecision.tsx` headers first.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/planning/engine/PlanningEngineBody.test.tsx`
Expected: FAIL — current order is Board → (Spec | Batch) → Smart Match.

- [ ] **Step 3: Reorder the render**

Replace the `return ( ... )` body of `PlanningEngineBody` with a single full-width stack and update the layout comment:

```tsx
  return (
    <div className="space-y-4">
      <SectionUpsAndSpec line={line} onPatch={onPatch} />
      <SectionBoardAllocation
        line={line}
        readiness={readiness}
        readinessLoading={readinessLoading}
        onPatch={onPatch}
        onSelectBoard={onSelectBoard}
        onReserve={onReserve}
        onRaisePR={onRaisePR}
      />
      <SectionSmartMatch
        line={line}
        readiness={readiness}
        onPatch={onPatch}
        onSelectBoard={onSelectBoard}
      />
      <SectionBatchDecision line={line} onPatch={onPatch} onLock={onLock} />
    </div>
  )
```

Update the doc comment above the component to describe the new top-to-bottom order (spec → board → match → commit).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/planning/engine/PlanningEngineBody.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/planning/engine/PlanningEngineBody.tsx src/components/planning/engine/PlanningEngineBody.test.tsx
git commit -m "feat(planning): reorder engine sections to Spec → Board → Smart Match → Batch"
```

---

## PHASE 2 — Warehouse Availability: reversible reservation + stock search

### Task 8: Stock-search endpoint + pure match helper

**Files:**
- Create: `src/lib/stock-search-match.ts`
- Test: `src/lib/stock-search-match.test.ts`
- Create: `src/app/api/planning/po-lines/[id]/stock-search/route.ts`

- [ ] **Step 1: Write the failing test for the pure helper**

Create `src/lib/stock-search-match.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { stockRowMatchesTerm, type StockSearchRow } from './stock-search-match'

const row: StockSearchRow = {
  materialCode: 'C-2304-280', boardType: 'CYBER', gsm: 280,
  sheetLength: 23, sheetWidth: 36, storageLocation: 'Rack B-12',
  supplierName: 'Sappi', lot: 'L-4471',
}

describe('stockRowMatchesTerm', () => {
  it('matches on size string in either orientation', () => {
    expect(stockRowMatchesTerm(row, '23x36')).toBe(true)
    expect(stockRowMatchesTerm(row, '36 x 23')).toBe(true)
  })
  it('matches on lot, location, supplier, code, gsm (case-insensitive)', () => {
    expect(stockRowMatchesTerm(row, 'l-4471')).toBe(true)
    expect(stockRowMatchesTerm(row, 'rack b')).toBe(true)
    expect(stockRowMatchesTerm(row, 'sappi')).toBe(true)
    expect(stockRowMatchesTerm(row, 'c-2304')).toBe(true)
    expect(stockRowMatchesTerm(row, '280')).toBe(true)
  })
  it('empty term matches everything', () => {
    expect(stockRowMatchesTerm(row, '')).toBe(true)
  })
  it('non-match returns false', () => {
    expect(stockRowMatchesTerm(row, 'zzz')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/stock-search-match.test.ts`
Expected: FAIL — cannot resolve module.

- [ ] **Step 3: Implement the pure helper**

Create `src/lib/stock-search-match.ts`:

```ts
export type StockSearchRow = {
  materialCode: string
  boardType: string | null
  gsm: number | null
  sheetLength: number | null
  sheetWidth: number | null
  storageLocation: string | null
  supplierName: string | null
  lot: string | null
}

function normSize(l: number | null, w: number | null): string[] {
  if (!l || !w) return []
  const a = String(Number(l))
  const b = String(Number(w))
  return [`${a}x${b}`, `${b}x${a}`]
}

export function stockRowMatchesTerm(row: StockSearchRow, term: string): boolean {
  const t = term.trim().toLowerCase().replace(/\s+/g, '')
  if (!t) return true
  const sizeForms = normSize(row.sheetLength, row.sheetWidth)
  const haystack = [
    row.materialCode,
    row.boardType,
    row.gsm != null ? String(row.gsm) : '',
    row.storageLocation,
    row.supplierName,
    row.lot,
    ...sizeForms,
  ]
    .filter(Boolean)
    .map((s) => String(s).toLowerCase().replace(/\s+/g, ''))
  return haystack.some((h) => h.includes(t))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/stock-search-match.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Implement the route (queries DB, refines with the helper)**

Create `src/app/api/planning/po-lines/[id]/stock-search/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/auth-helpers'
import { stockRowMatchesTerm, type StockSearchRow } from '@/lib/stock-search-match'

export async function GET(req: NextRequest, _context: { params: Promise<{ id: string }> }) {
  const { error } = await requireAuth()
  if (error) return error

  const q = (new URL(req.url).searchParams.get('q') || '').trim()
  if (q.length < 2) return NextResponse.json({ results: [] })

  // Broad DB prefilter on indexed/text columns; the pure helper refines (incl. size + lot).
  const rows = await db.inventory.findMany({
    where: {
      active: true,
      sheetLength: { gt: 0 },
      sheetWidth: { gt: 0 },
      OR: [
        { materialCode: { contains: q, mode: 'insensitive' } },
        { boardType: { contains: q, mode: 'insensitive' } },
        { storageLocation: { contains: q, mode: 'insensitive' } },
        { attributes: { contains: q } },
        { supplier: { name: { contains: q, mode: 'insensitive' } } },
      ],
    },
    select: {
      id: true, materialCode: true, boardType: true, gsm: true,
      sheetLength: true, sheetWidth: true, storageLocation: true,
      attributes: true, qtyAvailable: true, qtyReserved: true,
      supplier: { select: { name: true } },
    },
    take: 50,
  })

  // If the DB OR missed a size-only term, fall back to a wider scan, then refine.
  const pool =
    rows.length > 0
      ? rows
      : await db.inventory.findMany({
          where: { active: true, sheetLength: { gt: 0 }, sheetWidth: { gt: 0 } },
          select: {
            id: true, materialCode: true, boardType: true, gsm: true,
            sheetLength: true, sheetWidth: true, storageLocation: true,
            attributes: true, qtyAvailable: true, qtyReserved: true,
            supplier: { select: { name: true } },
          },
          take: 200,
        })

  const lotOf = (attributes: string | null): string | null => {
    if (!attributes) return null
    try {
      const p = JSON.parse(attributes) as Record<string, unknown>
      const v = p.lot ?? p.lotNumber ?? p.traceability
      return typeof v === 'string' ? v : null
    } catch {
      return null
    }
  }

  const results = pool
    .map((m) => {
      const free = Math.max(0, Number(m.qtyAvailable) - Number(m.qtyReserved))
      const searchRow: StockSearchRow = {
        materialCode: m.materialCode,
        boardType: m.boardType,
        gsm: m.gsm,
        sheetLength: m.sheetLength == null ? null : Number(m.sheetLength),
        sheetWidth: m.sheetWidth == null ? null : Number(m.sheetWidth),
        storageLocation: m.storageLocation,
        supplierName: m.supplier?.name ?? null,
        lot: lotOf(m.attributes),
      }
      return { m, free, searchRow }
    })
    .filter(({ searchRow }) => stockRowMatchesTerm(searchRow, q))
    .slice(0, 20)
    .map(({ m, free, searchRow }) => ({
      materialId: m.id,
      materialCode: m.materialCode,
      boardType: m.boardType,
      gsm: m.gsm,
      size: m.sheetLength && m.sheetWidth ? `${Number(m.sheetLength)} x ${Number(m.sheetWidth)}` : null,
      availableSheets: Number(m.qtyAvailable),
      reservedSheets: Number(m.qtyReserved),
      freeSheets: free,
      storageLocation: m.storageLocation,
      supplierName: searchRow.supplierName,
      lot: searchRow.lot,
    }))

  return NextResponse.json({ results })
}
```

(Confirm the auth helper import path matches the project — the reserve-material route imports `requireAuth` the same way; mirror that exact import.)

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors in the new route or helper.

- [ ] **Step 7: Commit**

```bash
git add src/lib/stock-search-match.ts src/lib/stock-search-match.test.ts "src/app/api/planning/po-lines/[id]/stock-search/route.ts"
git commit -m "feat(planning): add warehouse stock-search endpoint + pure match helper"
```

---

### Task 9: Warehouse Availability UI — Unreserve + partial release + stock search

**Files:**
- Modify: `src/components/planning/engine/SectionBoardAllocation.tsx`
- Test: `src/components/planning/engine/SectionBoardAllocation.test.tsx` (extend)

- [ ] **Step 1: Add props**

In `SectionBoardAllocation.tsx`, extend `Props`:

```ts
  /** Release reserved stock for this line. qty omitted = full release. */
  onRelease?: (qty?: number) => Promise<void>
  /** Server-side search across all warehouse stock. */
  onStockSearch?: (q: string) => Promise<StockSearchResult[]>
```

Add the result type near the top of the file:

```ts
export type StockSearchResult = {
  materialId: string
  materialCode: string
  boardType: string | null
  gsm: number | null
  size: string | null
  freeSheets: number
  reservedSheets: number
  storageLocation: string | null
  supplierName: string | null
  lot: string | null
}
```

Add `onRelease`, `onStockSearch` to the destructured props in the component signature.

- [ ] **Step 2: Write the failing tests**

Append to `SectionBoardAllocation.test.tsx` (mirror the existing render setup in that file — reuse its `line`/`readiness` fixtures):

```tsx
  it('shows Unreserve + partial release when reserved for this line', () => {
    const onRelease = vi.fn(async () => {})
    const r = { ...baseReadiness, materialId: 'm1', reservedForLine: 8650, reservedSheets: 8650 }
    render(
      <SectionBoardAllocation
        line={baseLine} readiness={r as never} readinessLoading={false}
        onPatch={async () => true} onReserve={async () => {}} onRelease={onRelease}
      />,
    )
    const unreserve = screen.getByRole('button', { name: /unreserve/i })
    fireEvent.click(unreserve)
    expect(onRelease).toHaveBeenCalledWith(undefined)
  })

  it('calls onRelease with a partial quantity', () => {
    const onRelease = vi.fn(async () => {})
    const r = { ...baseReadiness, materialId: 'm1', reservedForLine: 8650, reservedSheets: 8650 }
    render(
      <SectionBoardAllocation
        line={baseLine} readiness={r as never} readinessLoading={false}
        onPatch={async () => true} onReserve={async () => {}} onRelease={onRelease}
      />,
    )
    fireEvent.change(screen.getByLabelText(/release quantity/i), { target: { value: '2000' } })
    fireEvent.click(screen.getByRole('button', { name: /^release$/i }))
    expect(onRelease).toHaveBeenCalledWith(2000)
  })
```

(If the existing test file names its fixtures differently than `baseLine`/`baseReadiness`, use whatever it already defines. Add `reservedForLine` to the readiness fixture.)

- [ ] **Step 2b: Run to verify failure**

Run: `npx vitest run src/components/planning/engine/SectionBoardAllocation.test.tsx`
Expected: FAIL — no Unreserve/Release controls.

- [ ] **Step 3: Add reserve/unreserve controls**

Add local state + handlers near the other hooks (around the existing `reserving` state, line ~390):

```tsx
  const reservedForLine = Number(readiness?.reservedForLine ?? 0)
  const [releasing, setReleasing] = useState(false)
  const [releaseInput, setReleaseInput] = useState('')

  const handleRelease = useCallback(
    async (qty?: number) => {
      if (!onRelease || releasing) return
      setReleasing(true)
      try {
        await onRelease(qty)
        setReleaseInput('')
      } finally {
        setReleasing(false)
      }
    },
    [onRelease, releasing],
  )
```

In the reserved/positive-stock branch (the block around lines 597-621 that currently shows the Reserve button), render Reserve when nothing is reserved for the line, and Unreserve + partial release when something is:

```tsx
            {reservedForLine > 0 && onRelease ? (
              <div className="ml-3 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleRelease(undefined)}
                  disabled={releasing}
                  className="rounded-full border border-red-500/40 bg-red-500/15 px-3 py-1 text-xs font-semibold text-red-300 hover:bg-red-500/25 disabled:opacity-50 transition-colors"
                >
                  {releasing ? 'Releasing…' : 'Unreserve all'}
                </button>
                <label className="flex items-center gap-1 text-[11px] text-ds-ink-faint">
                  release
                  <input
                    aria-label="Release quantity"
                    inputMode="numeric"
                    value={releaseInput}
                    onChange={(e) => setReleaseInput(e.target.value.replace(/[^\d]/g, ''))}
                    className="w-16 rounded-md border border-ds-line bg-ds-base px-2 py-1 text-right tabular-nums text-ds-ink"
                  />
                  sh
                  <button
                    type="button"
                    onClick={() => {
                      const q = Number(releaseInput)
                      if (q > 0) void handleRelease(q)
                    }}
                    disabled={releasing || !releaseInput}
                    className="rounded-full border border-ds-line bg-ds-elevated px-2.5 py-1 font-semibold text-ds-ink-muted hover:border-ds-brand/50 disabled:opacity-50 transition-colors"
                  >
                    Release
                  </button>
                </label>
              </div>
            ) : canReserve ? (
              <button
                type="button"
                onClick={() => void handleReserve()}
                disabled={reserving}
                className="ml-3 rounded-full border border-emerald-500/40 bg-emerald-500/15 px-3 py-1 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-50 transition-colors"
              >
                {reserving ? 'Reserving…' : '✓ Reserve'}
              </button>
            ) : null}
```

- [ ] **Step 4: Add the stock-search UI**

Add state + debounced search near the other hooks:

```tsx
  const [searchTerm, setSearchTerm] = useState('')
  const [searchResults, setSearchResults] = useState<StockSearchResult[]>([])
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    if (!onStockSearch) return
    const q = searchTerm.trim()
    if (q.length < 2) {
      setSearchResults([])
      return
    }
    let cancelled = false
    setSearching(true)
    const t = setTimeout(async () => {
      try {
        const rows = await onStockSearch(q)
        if (!cancelled) setSearchResults(rows)
      } finally {
        if (!cancelled) setSearching(false)
      }
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [searchTerm, onStockSearch])
```

Render the search block near the top of the card body (after the title meta, before the option list). Selecting a row links the material via the existing `onSelectBoard`:

```tsx
      {onStockSearch ? (
        <div className="mt-3">
          <div className="text-[11px] uppercase tracking-wider text-ds-ink-faint mb-1.5">
            Search all warehouse stock
          </div>
          <input
            aria-label="Search warehouse stock"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Code, size, GSM, lot, location, supplier…"
            className="w-full rounded-ds-md border border-ds-line bg-ds-base px-3 py-2 text-sm text-ds-ink placeholder:text-ds-ink-faint"
          />
          {searching ? <div className="mt-2 text-xs text-ds-ink-faint">Searching…</div> : null}
          {searchResults.length > 0 ? (
            <div className="mt-2 space-y-1.5">
              {searchResults.map((r) => (
                <button
                  key={r.materialId}
                  type="button"
                  onClick={() => onSelectBoard && void onSelectBoard(r.materialId)}
                  className="flex w-full items-center justify-between gap-3 rounded-ds-md border border-ds-line bg-ds-elevated px-3 py-2 text-left text-xs hover:border-ds-brand/50 transition-colors"
                >
                  <span className="min-w-0">
                    <span className="font-semibold text-ds-ink">{r.materialCode}</span>
                    <span className="block text-ds-ink-faint truncate">
                      {[r.size, r.gsm ? `${r.gsm}g` : null, r.boardType].filter(Boolean).join(' · ')}
                      {r.lot ? ` · Lot ${r.lot}` : ''}
                      {r.storageLocation ? ` · ${r.storageLocation}` : ''}
                    </span>
                  </span>
                  <span className="shrink-0 text-right tabular-nums text-ds-ink-muted">
                    Free {nf.format(Math.round(r.freeSheets))}
                    {r.supplierName ? <span className="block text-ds-ink-faint">{r.supplierName}</span> : null}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
```

Ensure `useEffect` and `useState` are imported (they already are — line 3).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/components/planning/engine/SectionBoardAllocation.test.tsx`
Expected: PASS (existing + 2 new).

- [ ] **Step 6: Commit**

```bash
git add src/components/planning/engine/SectionBoardAllocation.tsx src/components/planning/engine/SectionBoardAllocation.test.tsx
git commit -m "feat(planning): Warehouse Availability gains Unreserve, partial release, and stock search"
```

---

### Task 10: Wire `onRelease` + `onStockSearch` through the drawer

**Files:**
- Modify: `src/components/planning/engine/PlanningEngineBody.tsx`
- Modify: `src/components/planning/PlanningJobDetailDrawer.tsx`

No new unit test — this is wiring between tested units. Verify by typecheck + the existing drawer tests + a manual browser check.

- [ ] **Step 1: Thread props through `PlanningEngineBody`**

Add to `PlanningEngineBodyProps`:

```ts
  onRelease?: (qty?: number) => Promise<void>
  onStockSearch?: (q: string) => Promise<import('./SectionBoardAllocation').StockSearchResult[]>
```

Destructure them and pass to `<SectionBoardAllocation … onRelease={onRelease} onStockSearch={onStockSearch} />`.

- [ ] **Step 2: Implement the handlers in `PlanningJobDetailDrawer.tsx`**

The drawer already renders the engine body and already POSTs to `reservation-control` and `reserve-material`. Add two callbacks and pass them to `<PlanningEngineBody … />`.

Release — POST the existing `reservation-control` endpoint with `action:'release'` (mirror the existing reservation-control usage around line 985; `requiredSheets` comes from the current readiness):

```tsx
  const handleEngineRelease = useCallback(
    async (qty?: number) => {
      const requiredSheets = Math.max(0, Number(readiness?.requiredSheets || 0))
      const reserved = Math.max(0, Number(readiness?.reservedForLine || 0))
      const releaseQty = qty == null ? reserved : Math.min(qty, reserved)
      if (releaseQty <= 0) return
      const res = await fetch(`/api/planning/po-lines/${line.id}/reservation-control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'release', releaseQty, requiredSheets }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        // surface error via the drawer's existing toast/error channel
        throw new Error((err as { message?: string }).message || 'Release failed')
      }
      await refreshReadiness() // call whatever the drawer already uses to reload readiness
    },
    [line.id, readiness, refreshReadiness],
  )

  const handleStockSearch = useCallback(
    async (q: string) => {
      const res = await fetch(`/api/planning/po-lines/${line.id}/stock-search?q=${encodeURIComponent(q)}`, {
        cache: 'no-store',
      })
      if (!res.ok) return []
      const out = (await res.json()) as { results?: unknown[] }
      return Array.isArray(out.results) ? (out.results as never[]) : []
    },
    [line.id],
  )
```

Replace `refreshReadiness()` with the drawer's actual readiness-reload function (the one already invoked after a successful reserve around line 871-918 — reuse that exact call so the UI updates in place).

Pass them down:

```tsx
        onRelease={handleEngineRelease}
        onStockSearch={handleStockSearch}
```

- [ ] **Step 3: Typecheck + full suite**

Run: `npm run typecheck`
Expected: no errors.
Run: `npm test`
Expected: PASS, including the new geometry/ranking/cut-fit/UI tests and the existing baseline (175 pass / 5 skip baseline — no regressions).

- [ ] **Step 4: Manual browser verification**

Start the dev server (`npm run dev`), open a planning line in the Job Detail drawer, and confirm:
- Sections appear in order Spec → Board → Smart Match → Batch.
- Smart Match shows ranked recommendations with balance/score/reason and a separate "Compatible alternatives" block.
- Reserve, then Unreserve all / partial Release round-trips and stock counts update.
- The stock-search bar finds materials by code/size/lot and Select links them.

- [ ] **Step 5: Commit**

```bash
git add src/components/planning/engine/PlanningEngineBody.tsx src/components/planning/PlanningJobDetailDrawer.tsx
git commit -m "feat(planning): wire engine release + stock search through the job-detail drawer"
```

---

## Final verification

- [ ] Run full suite: `npm test` — all green, no regressions vs the 175/5 baseline.
- [ ] Run typecheck: `npm run typecheck` — clean.
- [ ] Manual browser pass (Task 10, Step 4).

## Self-review notes (for the implementer)

- **Spec coverage:** reorder (Task 7), geometry+gripper (Task 1), reusable offcut + redefined waste (Task 1), ranking fulfillable-first (Task 2), make-ready (Tasks 3-5), strict/labeled-fallback split (Tasks 5-6), Smart Match UI (Task 6), reversible reservation (Tasks 9-10, reusing the existing `reservation-control` release endpoint), stock search (Tasks 8-10).
- **Confirm-before-coding:** real `CardSection` titles for Task 7's order assertion; the exact fixture names in `SectionBoardAllocation.test.tsx`; the drawer's actual readiness-refresh function name; the `requireAuth` import path. These are noted inline where they matter.
