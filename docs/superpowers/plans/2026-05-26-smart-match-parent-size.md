# Smart Match Parent-Size Input — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the Planning Engine's Smart Match section, replace the typed Child L/W inputs with an editable Parent L/W field that auto-fills from the Board Allocation child size + cut count (squarest tiling, snapped to a warehouse inventory-master size), with a live utilization preview — while the ranked warehouse list stays child-driven.

**Architecture:** A new pure function `computeParentFromChild` in `smart-match-parent-sheets.ts` does the geometry + snap. The readiness API surfaces distinct inventory-master sheet sizes as `masterSheetSizes`. `SectionSmartMatch.tsx` resolves child + cut from the line, computes/pre-fills the editable Parent field, and shows a live preview via the existing `computeEqualDivisionFit`. The existing `rankParentSheetMatches` call is unchanged.

**Tech Stack:** TypeScript, React (Next.js App Router), Vitest + @testing-library/react, Prisma.

**Reference spec:** `docs/superpowers/specs/2026-05-26-smart-match-parent-size-design.md`

---

## File Structure

- `src/lib/smart-match-parent-sheets.ts` — **modify**: add `ComputeParentResult` type + `computeParentFromChild`. Reuses module-private helpers (`num`, `round1`, `inferUnit`, `FIT_EPSILON`, `MM_PER_INCH`, `factorPairs`, `parseSheetDims`).
- `src/lib/smart-match-parent-sheets.test.ts` — **modify**: tests for `computeParentFromChild`.
- `src/components/planning/engine/types.ts` — **modify**: add `masterSheetSizes?: string[]` to `PlanningEngineReadiness`.
- `src/app/api/planning/po-lines/[id]/reserve-material/route.ts` — **modify**: distinct master-size query + add `masterSheetSizes` to the response.
- `src/components/planning/engine/SectionSmartMatch.tsx` — **modify**: child/cut resolution from line, editable Parent state + computed default, live preview, blocking copy.
- `src/components/planning/engine/SectionSmartMatch.test.tsx` — **modify**: update tests for Parent inputs + preview; add new cases.

---

## Task 1: `computeParentFromChild` in the lib

**Files:**
- Modify: `src/lib/smart-match-parent-sheets.ts`
- Test: `src/lib/smart-match-parent-sheets.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/smart-match-parent-sheets.test.ts`. First add `computeParentFromChild` to the import block at the top of the file (line 2-8):

```ts
import {
  parseSheetDims,
  factorPairs,
  computeEqualDivisionFit,
  rankParentSheetMatches,
  computeParentFromChild,
  type ParentSheetCandidate,
} from './smart-match-parent-sheets'
```

Then append this describe block at the end of the file:

```ts
describe('computeParentFromChild', () => {
  it('computes the squarest 2-cut parent (18×23 → 23×36) and snaps to a master size', () => {
    const r = computeParentFromChild({
      childLength: 18,
      childWidth: 23,
      cutType: 2,
      unit: 'inch',
      snapTargets: ['23 x 36', '25 x 38', '20 x 30'],
    })
    expect(r).not.toBeNull()
    expect([r!.rawLength, r!.rawWidth]).toEqual([23, 36])
    expect([r!.length, r!.width]).toEqual([23, 36])
    expect(r!.snappedTo).toBe('master')
  })

  it('falls back to the raw size when no master size is large enough', () => {
    const r = computeParentFromChild({
      childLength: 18,
      childWidth: 23,
      cutType: 2,
      unit: 'inch',
      snapTargets: ['20 x 30'],
    })
    expect([r!.rawLength, r!.rawWidth]).toEqual([23, 36])
    expect([r!.length, r!.width]).toEqual([23, 36])
    expect(r!.snappedTo).toBeNull()
  })

  it('picks the squarest grid for 4-cut (36×46) and 6-cut (46×54)', () => {
    const four = computeParentFromChild({ childLength: 18, childWidth: 23, cutType: 4, unit: 'inch' })
    expect([four!.rawLength, four!.rawWidth]).toEqual([36, 46])
    const six = computeParentFromChild({ childLength: 18, childWidth: 23, cutType: 6, unit: 'inch' })
    expect([six!.rawLength, six!.rawWidth]).toEqual([46, 54])
  })

  it('1-cut returns the child size itself', () => {
    const r = computeParentFromChild({ childLength: 18, childWidth: 23, cutType: 1, unit: 'inch' })
    expect([r!.rawLength, r!.rawWidth]).toEqual([18, 23])
    expect(r!.grid).toEqual([1, 1])
  })

  it('snaps against mm master sizes when the child is in inch', () => {
    // 23×36 in ≈ 584×914 mm; a 600×950 mm master should snap.
    const r = computeParentFromChild({
      childLength: 18,
      childWidth: 23,
      cutType: 2,
      unit: 'inch',
      snapTargets: ['600 x 950'],
    })
    expect(r!.snappedTo).toBe('master')
    expect(r!.length).toBeGreaterThanOrEqual(23)
  })

  it('returns null for non-positive child dims', () => {
    expect(computeParentFromChild({ childLength: 0, childWidth: 23, cutType: 2, unit: 'inch' })).toBeNull()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/smart-match-parent-sheets.test.ts`
Expected: FAIL — `computeParentFromChild is not a function` / not exported.

- [ ] **Step 3: Implement `computeParentFromChild`**

Add to `src/lib/smart-match-parent-sheets.ts`, immediately after the `computeEqualDivisionFit` function (before `function canonBoard`). It uses the module-private `num`, `round1`, `inferUnit`, `FIT_EPSILON`, `MM_PER_INCH`, and exported `factorPairs`, `parseSheetDims` already in this file.

```ts
export type ComputeParentResult = {
  /** Squarest geometric tiling of the child (sorted ascending), in the child's unit. */
  rawLength: number
  rawWidth: number
  /** After snapping to an inventory master size (== raw when no master fits). */
  length: number
  width: number
  snappedTo: 'master' | null
  /** Chosen [a, b] factor pair (a along length, b along width). */
  grid: [number, number]
}

/**
 * Compute the parent sheet needed to yield `cutType` children of the given size.
 * Tiles the child into the squarest a×b grid, then snaps up to the smallest
 * inventory-master size (`snapTargets`) that is ≥ the tiled parent in both dims.
 * Pure — no I/O. Returns null for invalid child dims.
 */
export function computeParentFromChild(input: {
  childLength: number
  childWidth: number
  cutType: CutType
  unit: LengthUnit
  snapTargets?: string[]
}): ComputeParentResult | null {
  const cl = num(input.childLength)
  const cw = num(input.childWidth)
  if (cl <= 0 || cw <= 0 || input.cutType < 1) return null

  // 1. Squarest tiling: minimise aspect ratio, tie-break on larger min-dimension.
  let grid: [number, number] = [1, 1]
  let tiledL = cl
  let tiledW = cw
  let bestRatio = Infinity
  let bestMinDim = -Infinity
  for (const [a, b] of factorPairs(input.cutType)) {
    const L = cl * a
    const W = cw * b
    const ratio = Math.max(L, W) / Math.min(L, W)
    const minDim = Math.min(L, W)
    if (ratio < bestRatio - 1e-9 || (Math.abs(ratio - bestRatio) <= 1e-9 && minDim > bestMinDim)) {
      bestRatio = ratio
      bestMinDim = minDim
      grid = [a, b]
      tiledL = L
      tiledW = W
    }
  }
  const rawLow = Math.min(tiledL, tiledW)
  const rawHigh = Math.max(tiledL, tiledW)

  // 2. Snap up to the smallest master size ≥ the tiled parent (orientation-aware).
  let length = round1(rawLow)
  let width = round1(rawHigh)
  let snappedTo: 'master' | null = null
  let bestArea = Infinity
  for (const label of input.snapTargets ?? []) {
    const dims = parseSheetDims(label)
    if (!dims) continue
    // Normalise the target into the child's unit by magnitude inference.
    const tUnit = inferUnit(Math.max(dims.length, dims.width))
    const conv = (n: number) =>
      tUnit === input.unit ? n : input.unit === 'inch' ? n / MM_PER_INCH : n * MM_PER_INCH
    const lo = Math.min(conv(dims.length), conv(dims.width))
    const hi = Math.max(conv(dims.length), conv(dims.width))
    if (lo + FIT_EPSILON >= rawLow && hi + FIT_EPSILON >= rawHigh) {
      const area = lo * hi
      if (area < bestArea - FIT_EPSILON) {
        bestArea = area
        length = round1(lo)
        width = round1(hi)
        snappedTo = 'master'
      }
    }
  }

  return { rawLength: round1(rawLow), rawWidth: round1(rawHigh), length, width, snappedTo, grid }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/smart-match-parent-sheets.test.ts`
Expected: PASS (all describe blocks, including the existing ones).

- [ ] **Step 5: Commit**

```bash
git add src/lib/smart-match-parent-sheets.ts src/lib/smart-match-parent-sheets.test.ts
git commit -m "feat(smart-match): computeParentFromChild — squarest tiling + master-size snap"
```

---

## Task 2: Surface `masterSheetSizes` on the readiness payload

**Files:**
- Modify: `src/components/planning/engine/types.ts:37`
- Modify: `src/app/api/planning/po-lines/[id]/reserve-material/route.ts` (~line 314 and ~line 627)

- [ ] **Step 1: Add the type field**

In `src/components/planning/engine/types.ts`, inside `PlanningEngineReadiness`, add after the `requiredFinalSize` line (line 37):

```ts
  requiredFinalSize?: string | null
  /** Distinct active board sheet sizes from the Inventory master, e.g. ["23 x 36", "25 x 38"]. Snap targets for the parent-size calculator. */
  masterSheetSizes?: string[]
```

- [ ] **Step 2: Query distinct master sizes in the route**

In `src/app/api/planning/po-lines/[id]/reserve-material/route.ts`, immediately after the `inventoryCandidatesAll` declaration (the block ending `: []` at ~line 314), add:

```ts
  const masterSizeRows = await db.inventory.findMany({
    where: { active: true, sheetLength: { gt: 0 }, sheetWidth: { gt: 0 } },
    select: { sheetLength: true, sheetWidth: true },
    distinct: ['sheetLength', 'sheetWidth'],
    take: 500,
  })
  const masterSheetSizes = Array.from(
    new Set(
      masterSizeRows
        .map((r) => {
          const l = Number(r.sheetLength)
          const w = Number(r.sheetWidth)
          return Number.isFinite(l) && Number.isFinite(w) && l > 0 && w > 0 ? `${l} x ${w}` : null
        })
        .filter((s): s is string => s !== null),
    ),
  )
```

- [ ] **Step 3: Add the field to the response**

In the same file, in the `return NextResponse.json({ ... })` block (~line 600), add after the `requiredFinalSize:` line (~line 627):

```ts
    requiredFinalSize: requiredSizePair ? `${requiredSizePair.length} x ${requiredSizePair.width}` : null,
    masterSheetSizes,
```

- [ ] **Step 4: Verify it compiles**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "reserve-material|types.ts" || echo "no type errors in touched files"`
Expected: `no type errors in touched files`.

- [ ] **Step 5: Commit**

```bash
git add src/components/planning/engine/types.ts "src/app/api/planning/po-lines/[id]/reserve-material/route.ts"
git commit -m "feat(planning): surface distinct inventory-master sheet sizes on readiness"
```

---

## Task 3: SectionSmartMatch — resolve child/cut from line, editable Parent field

**Files:**
- Modify: `src/components/planning/engine/SectionSmartMatch.tsx`
- Test: `src/components/planning/engine/SectionSmartMatch.test.tsx`

This task replaces the Child L/W inputs with Parent L/W inputs pre-filled from `computeParentFromChild`, sources the child + cut from the line, and keeps `rankParentSheetMatches` child-driven.

- [ ] **Step 1: Update imports + helpers in `SectionSmartMatch.tsx`**

Extend the lib import (currently lines 5-14) to add `computeParentFromChild`:

```ts
import {
  CUT_TYPES,
  parseSheetDims,
  rankParentSheetMatches,
  computeParentFromChild,
  type CutType,
  type LengthUnit,
  type ParentSheetCandidate,
  type ParentSheetMatch,
  type ParentSheetMatchLabel,
} from '@/lib/smart-match-parent-sheets'
```

Replace the `defaultChildDims` helper (lines 265-270) with a richer resolver that prefers the Board-Allocation child (`sheetSpec.childSize`) and the resolved cut type:

```ts
function resolveChildAndCut(line: PlanningEngineLine): {
  l: string
  w: string
  unit: LengthUnit
  cut: CutType
} {
  const sizeStr = line.sheetSpec?.childSize ?? line.cartonSize ?? null
  const dims = parseSheetDims(sizeStr)
  const unit: LengthUnit =
    line.sheetSpec?.unit === 'mm' || (dims && Math.max(dims.length, dims.width) > 200) ? 'mm' : 'inch'
  const rawCut = line.sheetSpec?.cutType
  const cut = (rawCut && rawCut >= 1 && rawCut <= 6 ? Math.round(rawCut) : 1) as CutType
  if (!dims) return { l: '', w: '', unit, cut }
  return { l: String(dims.length), w: String(dims.width), unit, cut }
}
```

- [ ] **Step 2: Update the failing component tests first**

Edit `src/components/planning/engine/SectionSmartMatch.test.tsx`. The matcher is still child-driven, so existing rank tests keep working once child comes from the line. Replace the three tests that referenced `Child L`/`Child W`/`Enter the child sheet size`:

Replace the `'shows the spec empty state with actions when nothing matches'` test (lines 87-95) with:

```ts
  it('shows the no-match empty state with actions when the child cannot be cut', () => {
    // Child larger than any parent can never be cut from stock.
    const line = { ...baseLine, cartonSize: '99x99' } as unknown as PlanningEngineLine
    render(<SectionSmartMatch line={line} readiness={readiness} onPatch={async () => true} />)
    fireEvent.change(screen.getByLabelText('Cut type'), { target: { value: '2' } })
    expect(screen.getByText(/No matching parent sheet available/i)).toBeInTheDocument()
    expect(screen.getByText(/Raise Purchase Request/i)).toBeInTheDocument()
    expect(screen.getByText(/Try a different cut type/i)).toBeInTheDocument()
  })
```

Replace the `'prompts for child size when none is entered'` test (lines 97-101) with:

```ts
  it('blocks with a Board Allocation prompt when no child size is resolvable', () => {
    const line = { ...baseLine, cartonSize: null } as unknown as PlanningEngineLine
    render(<SectionSmartMatch line={line} readiness={readiness} onPatch={async () => true} />)
    expect(screen.getByText(/Set the carton size in Board Allocation/i)).toBeInTheDocument()
  })
```

Add a new test after it (the editable Parent field pre-fills from child × cut):

```ts
  it('pre-fills an editable Parent field from the child size and cut count', () => {
    // baseLine child = 12×23; 2-cut squarest tiling = 23×24 → snaps to a master 23×36? No —
    // use a child that tiles to 23×36 at 2-cut: child 18×23.
    const line = { ...baseLine, cartonSize: '18x23' } as unknown as PlanningEngineLine
    render(<SectionSmartMatch line={line} readiness={readiness} onPatch={async () => true} />)
    fireEvent.change(screen.getByLabelText('Cut type'), { target: { value: '2' } })
    const parentL = screen.getByLabelText('Parent L') as HTMLInputElement
    const parentW = screen.getByLabelText('Parent W') as HTMLInputElement
    expect(parentL.value).toBe('23')
    expect(parentW.value).toBe('36')
    // The derived child is shown as a read-only sub-label.
    expect(screen.getByText(/Child 18 × 23/i)).toBeInTheDocument()
  })
```

Update the `'renders warehouse parent-sheet matches...'` test (lines 71-79) and the `'rejects parents...'` and `'calls onSelectBoard...'` tests: they set the cut type to 2 and rely on child 12×23 from `baseLine.cartonSize`. These still work because the matcher reads the resolved child from the line — no `Child L` field interaction needed. Leave their assertions as-is (they assert on `#1 · 23 × 36 in`, `Select parent sheet 23 × 36 in`, absence of `20 × 30`).

- [ ] **Step 3: Run the component tests to verify they fail**

Run: `npx vitest run src/components/planning/engine/SectionSmartMatch.test.tsx`
Expected: FAIL — `Parent L` label not found / `Set the carton size in Board Allocation` not found (component not yet updated).

- [ ] **Step 4: Rewrite the SectionSmartMatch body**

Replace the component body from the `export const SectionSmartMatch = memo(...)` declaration (line 272) through the end of the input-row `</div>` and empty-state branches. Specifically:

Replace the state setup (lines 279-326) with:

```ts
export const SectionSmartMatch = memo(function SectionSmartMatch({
  line,
  readiness,
  onPatch: _onPatch,
  onSelectBoard,
  sidebar = false,
}: Props) {
  const candidates = useMemo<ParentSheetCandidate[]>(() => {
    const strict = readiness?.suggestedBoardOptions ?? []
    const fallback = readiness?.closestAvailableOptions ?? []
    const merged = new Map<string, ParentSheetCandidate>()
    for (const o of [...strict, ...fallback]) {
      if (!merged.has(o.materialId)) merged.set(o.materialId, toCandidate(o))
    }
    return Array.from(merged.values())
  }, [readiness])

  const resolved = useMemo(() => resolveChildAndCut(line), [line])
  const childL = Number(resolved.l)
  const childW = Number(resolved.w)
  const childEntered = childL > 0 && childW > 0

  const [unit, setUnit] = useState<LengthUnit>(resolved.unit)
  const [cutType, setCutType] = useState<CutType>(resolved.cut)
  const defaultQty = String(Math.max(1, Math.round(readiness?.requiredSheets || line.quantity || 1)))
  const [requiredQty, setRequiredQty] = useState(defaultQty)

  const snapTargets = useMemo(() => readiness?.masterSheetSizes ?? [], [readiness])

  const computedParent = useMemo(
    () =>
      childEntered
        ? computeParentFromChild({ childLength: childL, childWidth: childW, cutType, unit, snapTargets })
        : null,
    [childEntered, childL, childW, cutType, unit, snapTargets],
  )

  const [parentLength, setParentLength] = useState('')
  const [parentWidth, setParentWidth] = useState('')
  const [parentTouched, setParentTouched] = useState(false)

  // Re-seed the Parent field from the computed default until the planner edits it.
  useEffect(() => {
    if (parentTouched || !computedParent) return
    setParentLength(String(computedParent.length))
    setParentWidth(String(computedParent.width))
  }, [computedParent, parentTouched])

  const onParentLength = useCallback((v: string) => {
    setParentTouched(true)
    setParentLength(v)
  }, [])
  const onParentWidth = useCallback((v: string) => {
    setParentTouched(true)
    setParentWidth(v)
  }, [])

  const matches = useMemo<ParentSheetMatch[]>(() => {
    if (!childEntered) return []
    return rankParentSheetMatches({
      childLength: childL,
      childWidth: childW,
      cutType,
      requiredQty: Number(requiredQty) || 1,
      unit,
      boardType: readiness?.boardType ?? null,
      gsm: readiness?.gsm ?? null,
      candidates,
    })
  }, [childEntered, childL, childW, cutType, requiredQty, unit, readiness?.boardType, readiness?.gsm, candidates])

  const selectedMaterialId = readiness?.materialId ?? null

  const handleSelect = useCallback(
    (materialId: string) => {
      void onSelectBoard?.(materialId)
    },
    [onSelectBoard],
  )

  const blocking = deriveBlockingEmptyState(line, readiness, candidates.length)
  const matchBasis =
    [readiness?.boardType, readiness?.gsm ? `${readiness.gsm} gsm` : null].filter(Boolean).join(' · ') || '—'
  const childLabel = childEntered ? `Child ${resolved.l} × ${resolved.w} ${unit === 'mm' ? 'mm' : 'in'}` : null
```

Add `useEffect` to the React import at the top (line 3): `import { memo, useCallback, useEffect, useMemo, useState } from 'react'`.

Now replace the input-row JSX (the `grid gap-2 mb-3` block, lines 336-367) with Parent inputs + the derived child sub-label:

```tsx
      <div className={`grid gap-2 mb-3 ${sidebar ? 'grid-cols-2' : 'grid-cols-2 sm:grid-cols-4 lg:grid-cols-6'}`}>
        <ControlNumber label="Parent L" value={parentLength} onChange={onParentLength} suffix={unit === 'mm' ? 'mm' : 'in'} />
        <ControlNumber label="Parent W" value={parentWidth} onChange={onParentWidth} suffix={unit === 'mm' ? 'mm' : 'in'} />
        <div className="bg-ds-elevated rounded-ds-md border border-ds-line/40 px-2.5 py-2">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-ds-ink-faint mb-0.5">Unit</div>
          <select
            value={unit}
            onChange={(e) => setUnit(e.target.value as LengthUnit)}
            aria-label="Unit"
            className="w-full bg-transparent text-sm font-semibold text-ds-ink outline-none"
          >
            <option value="inch">inch</option>
            <option value="mm">mm</option>
          </select>
        </div>
        <div className="bg-ds-elevated rounded-ds-md border border-ds-line/40 px-2.5 py-2">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-ds-ink-faint mb-0.5">Cut type</div>
          <select
            value={cutType}
            onChange={(e) => { setParentTouched(false); setCutType(Number(e.target.value) as CutType) }}
            aria-label="Cut type"
            className="w-full bg-transparent text-sm font-semibold text-ds-ink outline-none tabular-nums"
          >
            {CUT_TYPES.map((c) => (
              <option key={c} value={c}>
                {c}-cut
              </option>
            ))}
          </select>
        </div>
        <ControlNumber label="Required qty" value={requiredQty} onChange={setRequiredQty} suffix="sh" />
      </div>
      {childLabel ? (
        <div className="-mt-1.5 mb-3 text-[11px] text-ds-ink-faint">
          {childLabel} · from Board Allocation{computedParent?.snappedTo === 'master' ? ' · parent snapped to a stock size' : ''}
        </div>
      ) : null}
```

Now update the empty-state branch order (lines 369-391). The `!childEntered` branch text changes to the Board-Allocation prompt:

```tsx
      {blocking ? (
        <BlockingEmptyState title={blocking.title} detail={blocking.detail} warn={blocking.kind === 'spec-incomplete'} />
      ) : !childEntered ? (
        <BlockingEmptyState
          title="Set the carton size in Board Allocation"
          detail="Smart Match derives the child size and cut count from Board Allocation to compute the parent sheet. Set the carton size above to continue."
          warn={false}
        />
      ) : matches.length > 0 ? (
        <div className={`grid gap-3 ${sidebar ? 'grid-cols-1' : 'grid-cols-1 lg:grid-cols-2'}`}>
          {matches.slice(0, 6).map((m, idx) => (
            <ParentMatchCard
              key={m.materialId}
              m={m}
              rank={idx + 1}
              selected={!!selectedMaterialId && m.materialId === selectedMaterialId}
              onSelect={onSelectBoard ? handleSelect : undefined}
            />
          ))}
        </div>
      ) : (
        <NoMatchEmptyState />
      )}
```

Delete the now-unused `defaultChildDims` function and the old `childLength/childWidth/setChildLength/setChildWidth` references (replaced above). Leave `ParentMatchCard`, `MatchField`, `ControlNumber`, `deriveBlockingEmptyState`, `NoMatchEmptyState`, `BlockingEmptyState`, `toCandidate`, `labelClass` untouched.

- [ ] **Step 5: Run the component tests to verify they pass**

Run: `npx vitest run src/components/planning/engine/SectionSmartMatch.test.tsx`
Expected: PASS (all tests, including the rank tests that read child from the line).

- [ ] **Step 6: Commit**

```bash
git add src/components/planning/engine/SectionSmartMatch.tsx src/components/planning/engine/SectionSmartMatch.test.tsx
git commit -m "feat(smart-match): editable Parent field derived from Board Allocation child + cut"
```

---

## Task 4: Live utilization preview + matching-card highlight

**Files:**
- Modify: `src/components/planning/engine/SectionSmartMatch.tsx`
- Test: `src/components/planning/engine/SectionSmartMatch.test.tsx`

- [ ] **Step 1: Write the failing tests**

Add to `SectionSmartMatch.test.tsx`:

```ts
  it('shows a live preview for the entered Parent and updates when it is edited', () => {
    const line = { ...baseLine, cartonSize: '18x23' } as unknown as PlanningEngineLine
    render(<SectionSmartMatch line={line} readiness={readiness} onPatch={async () => true} />)
    fireEvent.change(screen.getByLabelText('Cut type'), { target: { value: '2' } })
    // Default parent 23×36 → 2 pieces/sheet for an 18×23 child.
    expect(screen.getByText(/2 pcs\/sheet/i)).toBeInTheDocument()
    // Shrink the parent below the child → preview shows the too-small note.
    fireEvent.change(screen.getByLabelText('Parent L'), { target: { value: '10' } })
    fireEvent.change(screen.getByLabelText('Parent W'), { target: { value: '10' } })
    expect(screen.getByText(/parent is smaller than the child/i)).toBeInTheDocument()
  })
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/planning/engine/SectionSmartMatch.test.tsx -t "live preview"`
Expected: FAIL — `2 pcs/sheet` not found.

- [ ] **Step 3: Implement the preview**

In `SectionSmartMatch.tsx`, import `computeEqualDivisionFit` (add to the lib import block from Task 3):

```ts
  CUT_TYPES,
  parseSheetDims,
  rankParentSheetMatches,
  computeParentFromChild,
  computeEqualDivisionFit,
```

After the `matches` useMemo (Task 3), add the preview computation:

```ts
  const preview = useMemo(() => {
    const pl = Number(parentLength)
    const pw = Number(parentWidth)
    if (!childEntered || !Number.isFinite(pl) || !Number.isFinite(pw) || pl <= 0 || pw <= 0) return null
    const fit = computeEqualDivisionFit({
      parentLength: pl,
      parentWidth: pw,
      childLength: childL,
      childWidth: childW,
      cutType,
    })
    const qty = Number(requiredQty) || 1
    const requiredParentSheets = fit.piecesPerSheet > 0 ? Math.max(1, Math.ceil(qty / fit.piecesPerSheet)) : 0
    const lo = Math.min(pl, pw)
    const hi = Math.max(pl, pw)
    const matchCard =
      matches.find((m) => {
        const d = parseSheetDims(m.parentSize)
        return d && Math.abs(Math.min(d.length, d.width) - lo) < 0.5 && Math.abs(Math.max(d.length, d.width) - hi) < 0.5
      }) ?? null
    return { fit, requiredParentSheets, matchCard }
  }, [childEntered, parentLength, parentWidth, childL, childW, cutType, requiredQty, matches])

  const highlightMaterialId = preview?.matchCard?.materialId ?? null
```

Render a preview block immediately after the child sub-label (before the empty-state branches):

```tsx
      {childEntered && preview ? (
        <div className="mb-3 rounded-ds-md border border-ds-line/40 bg-ds-elevated/40 p-3">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-ds-ink-faint mb-1.5">
            Parent {parentLength} × {parentWidth} {unit === 'mm' ? 'mm' : 'in'} · {cutType}-cut preview
          </div>
          {preview.fit.piecesPerSheet > 0 ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ds-ink tabular-nums">
              <span>{nf.format(preview.fit.piecesPerSheet)} pcs/sheet</span>
              <span>·</span>
              <span>{preview.fit.utilizationPct}% used</span>
              <span>·</span>
              <span>{preview.fit.wastePct}% waste</span>
              <span>·</span>
              <span>Need {nf.format(preview.requiredParentSheets)} sh</span>
              {preview.matchCard ? (
                <>
                  <span>·</span>
                  <span className="text-emerald-300">
                    {nf.format(Math.max(0, Math.round(preview.matchCard.freeStock)))} free in stock
                  </span>
                </>
              ) : null}
            </div>
          ) : (
            <div className="text-xs text-amber-300">Parent is smaller than the child — no pieces fit.</div>
          )}
        </div>
      ) : null}
```

Finally, highlight the matching warehouse card: in the `matches.slice(0, 6).map(...)` render (from Task 3), change the `selected` prop:

```tsx
              selected={
                (!!selectedMaterialId && m.materialId === selectedMaterialId) ||
                m.materialId === highlightMaterialId
              }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/components/planning/engine/SectionSmartMatch.test.tsx`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/planning/engine/SectionSmartMatch.tsx src/components/planning/engine/SectionSmartMatch.test.tsx
git commit -m "feat(smart-match): live parent utilization preview + stock-match highlight"
```

---

## Task 5: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Typecheck the touched files**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "SectionSmartMatch|smart-match-parent-sheets|reserve-material|engine/types" || echo "clean"`
Expected: `clean`.

- [ ] **Step 2: Run the full affected test set**

Run: `npx vitest run src/lib/smart-match-parent-sheets.test.ts src/components/planning/engine/SectionSmartMatch.test.tsx`
Expected: PASS, no failures.

- [ ] **Step 3: Lint the touched files**

Run: `npx eslint src/lib/smart-match-parent-sheets.ts src/components/planning/engine/SectionSmartMatch.tsx "src/app/api/planning/po-lines/[id]/reserve-material/route.ts"`
Expected: no errors (warnings acceptable if pre-existing).

- [ ] **Step 4: Manual smoke (optional, if dev server available)**

Open the Planning Engine for a PO line with a carton size + linked board, confirm: Parent L/W pre-fills (e.g. 18×23 child, 2-cut → 23×36), the child sub-label reads "from Board Allocation", editing Parent updates the preview, and the warehouse match list still lists every fitting parent.

- [ ] **Step 5: Commit any final fixes**

```bash
git add -A
git commit -m "test(smart-match): verification pass for parent-size input" || echo "nothing to commit"
```

---

## Self-Review notes (for the implementer)

- **Spec coverage:** Task 1 → §2/§2a (compute + snap); Task 2 → §2a data source; Task 3 → §1 (child/cut from Board Allocation) + §3 (editable Parent) + §4 (list unchanged) + blocking copy; Task 4 → §3 (preview + highlight). Edge cases (cuts=1, no master ≥ raw, missing `masterSheetSizes`, mm/inch, parent < child) covered by Task 1 + Task 4 tests.
- **Matching is unchanged:** `rankParentSheetMatches` still receives the resolved child — the Parent field never filters the list (spec §4).
- **`snappedTo` provenance** is surfaced only as a small sub-label note; no behavioural dependency.
