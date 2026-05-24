# Planning Engine — 13-Area Robustness Build — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing Planning Engine modal into a packaging-plant-grade board-allocation + smart-match planning framework that fulfils all 13 requirement areas, **without redesigning the UI** — the current section shells, theme, spacing, cards and buttons stay; we fill in the data, fields, logic and wiring they were built to hold.

**Architecture:** The engine UI (`PlanningEngineBody` + 4 `Section*` components) was built UI-first against a rich view-model type (`PlanningEngineLine` in `engine/types.ts`) but the drawer never populates `upsAndSpec` / `smartMatch` / `batchDecision` — it passes the raw grid row via `line as unknown as PlanningEngineLine`. **Root cause: an absent adapter.** The plan's keystone (Phase 1) is a pure `buildEngineLine()` adapter that synthesizes the view-model from the data the drawer already fetches (`readiness`) + the line's `specOverrides`. Once the adapter exists, the already-built UI lights up (tiles, gang cards, and a re-enabled Save & Lock). Later phases add the genuinely-new fields (separate sheet L/W, cut-type, make-ready), the composite smart-match scoring engine, the warehouse popup, reservation/PR completeness, gang compatibility, validation, and the downstream lock→job-card flow, then delete the dead legacy body.

**Tech Stack:** Next.js (App Router) · React · TypeScript · Prisma · Vitest + React Testing Library (`npm test` = `vitest run`, jsdom, globals on, `@` → `src`). Design-system primitives: `@/components/design-system/{CardSection,Badge,Button}`. Spec helpers: `@/lib/planning-decision-spec` (`readPlanningCore`, `readPlanningMeta`, `mergePlanningMetaUps`). Calc: `@/lib/production-os-resolvers` (`resolveUps`, `resolveRequirementFromLine`). Sheet size: `@/lib/planning-sheet-size` (`resolveSheetSize`). Cut-fit: `@/lib/material-cut-fit`.

---

## Ground rules (read before any task)

1. **Do not touch the visual design.** Reuse existing components (`CardSection`, `Badge`, `Button`, `MetricTile`, `EditableTile`, `ReadOnlyTile`, `SegmentedPill`, `WarehouseStrip`, `SubScoreBar`). New tiles/fields must use the same classes already present in the file you edit. No new color tokens, no layout rewrites except where a requirement explicitly adds a section.
2. **Incremental & safe.** Never change a persisted formula in a way that silently alters existing reservations. The make-ready bucket (Phase 2) defaults to `0` so existing `Total = base + wastage` is unchanged until a planner sets it.
3. **TDD.** Each task: write the failing test → run it red → implement → run it green → commit. Test command for one file: `npm test -- src/path/to/file.test.tsx`. Full suite: `npm test`.
4. **Baseline (MEASURED 2026-05-24).** `npm test` → **163 passed / 5 failed (168 total)**. The 5 pre-existing failures are all in two files this plan modifies, and they are *aspirational* tests written ahead of the code:
   - `src/components/planning/engine/SectionUpsAndSpec.test.tsx` — 3 fails: tests expect an **editable** "Units per sheet" input + "Auto" chip in this section (lines 29, 49, 63). The component deliberately renders UPS read-only here (editing lives in Board Allocation). **Resolution (Phase 2.5):** update these 3 tests to match the read-only design (assert the read-only tile value + that editing is in Board Allocation), keeping the make-ready/BPI assertions which already pass.
   - `src/components/planning/engine/SectionBoardAllocation.test.tsx` — 2 fails: `getByText('4,800 sh')` (line 41) and `getByText('1,240 sh')` (line 47) — a sheet-count **formatting** mismatch (component formats differently). **Resolution (Phase 2.4):** when editing this file, align the formatting OR update the assertion to the actual format; AND update line 39's single-`Sheet size`-field assertion to the new Length/Width fields.
   Every task must keep the pass count ≥ 163 and must NOT introduce failures beyond these 5. As tasks fix the stale tests, the pass count rises and the failing set shrinks — the final gate (7.2) target is 0 unexpected failures.
5. **No backend formula divergence.** When `requiredSheets` changes shape (Phase 2 make-ready), update **all three** sites consistently: `production-os-resolvers.ts` (`resolveRequirementFromLine`), the readiness GET route, and `buildEngineLine`. They must agree.
6. **Type source of truth:** `src/components/planning/engine/types.ts`. Extend it explicitly when a new field is needed; never widen via `any`.

---

## File Structure

**New files:**
- `src/components/planning/engine/buildEngineLine.ts` — pure adapter: `(line, readiness, extras) → PlanningEngineLine`. The keystone. Owns `upsAndSpec`, `batchDecision`, `smartMatch` synthesis + the `readinessFive` validation gate.
- `src/components/planning/engine/buildEngineLine.test.ts` — unit tests for the adapter.
- `src/components/planning/engine/planningValidation.ts` — pure validation: `computeReadinessFive(...)` and `computeReleaseGuard(...)`. Imported by the adapter and by `SectionBatchDecision` indirectly via the view-model. Keeps req-10 rules in one testable place.
- `src/components/planning/engine/planningValidation.test.ts`
- `src/lib/planning-smart-match.ts` — composite gang-suggestion scoring engine (size/waste/urgency/tool → composite, tiers, #1–#5 labels). Pure.
- `src/lib/planning-smart-match.test.ts`
- `src/components/planning/engine/SectionProductRequirement.tsx` — req-1/req-9 Section 1 identity + requirement card.
- `src/components/planning/engine/SectionProductRequirement.test.tsx`
- `src/components/planning/engine/SectionWarehouseAvailability.tsx` — req-9 Section 3 (wraps stock views; hosts the "Open warehouse" trigger).
- `src/components/planning/engine/SectionWarehouseAvailability.test.tsx`
- `src/components/planning/engine/WarehousePopup.tsx` — req-5 popup (full / filtered / suggested / reserved / free tabs).
- `src/components/planning/engine/WarehousePopup.test.tsx`
- `src/app/api/planning/po-lines/[id]/gang-candidates/route.ts` — req-4 data source for composite suggestions (sibling compatible lines).

**Modified files:**
- `src/components/planning/engine/types.ts` — add `sheetSpec` (length/width/unit/cutType/childSize), `makeReady` source, `matchScorePct`/`reason` on board option, `releaseGuard` on batchDecision.
- `src/components/planning/PlanningJobDetailDrawer.tsx` — replace the `as unknown as` casts with `buildEngineLine(...)`; add operator/press fetch for designer/press options; re-home Unreserve/Adjust triggers into live engine; wire lock→downstream; delete `{false && …}` block (Phase 7).
- `src/components/planning/engine/PlanningEngineBody.tsx` — render the two new sections in the spec'd order; thread `readiness`/handlers to children that now need them.
- `src/components/planning/engine/SectionBoardAllocation.tsx` — replace single "Sheet size" field with Length/Width/Unit + Cut-type selector + Child-size; keep the rest.
- `src/components/planning/engine/SectionUpsAndSpec.tsx` — add Make-ready / Expected-yield (Allocated×UPS) / Balance-after-allocation tiles.
- `src/components/planning/engine/SectionSmartMatch.tsx` — add Match Score % + Reason + semantic #1–#5 rank labels to board cards.
- `src/components/planning/engine/SectionBatchDecision.tsx` — block "Released" status when `releaseGuard` fails; surface gang-compat warnings.
- `src/lib/production-os-resolvers.ts` — add a separate `makeReadySheets` bucket; `requiredSheets = base + makeReady + wastage`.
- `src/lib/planning-decision-spec.ts` — add `sheetLengthMm`/`sheetWidthMm`/`sheetUnit`/`cutType`/`makeReadySheets` to the planning meta/core read/write helpers.
- `src/app/api/planning/po-lines/[id]/reserve-material/route.ts` — thread make-ready into the calc + response; add `matchScorePct`/`reason` to options; record planner name on reserve.
- `src/app/api/material-shortages/[id]/create-pr/route.ts` + `src/lib/material-readiness-service.ts` — populate the missing PR fields (Required Sheets, Customer PO, Product Name).
- `src/app/api/planning/po-lines/make-processing/route.ts` — extend gang gate to board type / print side / sheet size / delivery / press with structured conflict payload.
- `src/app/(dashboard)/orders/planning/page.tsx` — pass new props (operators, gang candidates) to the drawer; wire lock→job-card.
- `prisma/schema.prisma` (+ migration) — add `requiredSheets`, `customerPoNumber`, `productName` columns to `PurchaseRequisition`; add `reservedByName` to the reservation stock-movement (Phase 5).

---

# PHASE 0 — Baseline

### Task 0: Record the test baseline

**Files:** none (read-only).

- [ ] **Step 1: Run the full suite**

Run: `npm test`
Expected: a pass/fail summary like `Tests  N passed | M failed`. Record N and M. Per project memory baseline is ~175 passed / ~5 failed (pre-existing). Those 5 failures are NOT introduced by this plan — note their names so you can distinguish them later.

- [ ] **Step 2: Confirm the engine test files run**

Run: `npm test -- src/components/planning/engine/`
Expected: `SectionSmartMatch.test.tsx`, `SectionUpsAndSpec.test.tsx`, `SectionBoardAllocation.test.tsx`, `SectionBatchDecision.test.tsx` all execute. Record their pass count — Phase 1 must not regress them.

---

# PHASE 1 — Foundation: the engine-line adapter (Root Cause A)

This phase makes the *existing* UI functional. No new visible fields — the tiles, gang cards and Save & Lock button that currently render blank/disabled start working because they finally receive data. Fulfils the data half of req-3, req-4 (single-board ranking already computed by readiness), and the gate half of req-10.

### Task 1.1: Validation module — `computeReadinessFive`

**Files:**
- Create: `src/components/planning/engine/planningValidation.ts`
- Test: `src/components/planning/engine/planningValidation.test.ts`

`readinessFive` is what `SectionBatchDecision` reads to enable Save & Lock (`canLock = readinessFive?.allReady === true`). Today it's `undefined` → button permanently disabled. We compute it from real inputs. Req-10 rules: UPS present, sheet length+width present, board type + GSM present, a board allocation decision made (a material selected), and shortage either zero or covered by a raised/approved PR.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { computeReadinessFive, computeReleaseGuard } from './planningValidation'

const ok = {
  ups: 4,
  sheetLengthMm: 760,
  sheetWidthMm: 1020,
  boardType: 'FBB',
  gsm: 300,
  materialSelected: true,
  shortageSheets: 0,
  prStatus: 'not_created',
}

describe('computeReadinessFive', () => {
  it('is allReady when every gate passes and no shortage', () => {
    const r = computeReadinessFive(ok)
    expect(r.allReady).toBe(true)
    expect(r.blockers).toEqual([])
  })

  it('blocks when UPS missing', () => {
    const r = computeReadinessFive({ ...ok, ups: null })
    expect(r.allReady).toBe(false)
    expect(r.blockers).toContain('UPS not set')
  })

  it('blocks when sheet length or width missing', () => {
    expect(computeReadinessFive({ ...ok, sheetLengthMm: null }).blockers).toContain('Sheet size incomplete')
    expect(computeReadinessFive({ ...ok, sheetWidthMm: null }).blockers).toContain('Sheet size incomplete')
  })

  it('blocks when board type or GSM missing', () => {
    expect(computeReadinessFive({ ...ok, boardType: null }).blockers).toContain('Board type / GSM missing')
    expect(computeReadinessFive({ ...ok, gsm: null }).blockers).toContain('Board type / GSM missing')
  })

  it('blocks when no board allocation decision made', () => {
    expect(computeReadinessFive({ ...ok, materialSelected: false }).blockers).toContain('No board allocated')
  })

  it('blocks lock when shortage exists and no PR raised', () => {
    expect(computeReadinessFive({ ...ok, shortageSheets: 500 }).blockers).toContain('Shortage — raise PR or approval')
  })

  it('allows lock when shortage covered by a pending PR', () => {
    const r = computeReadinessFive({ ...ok, shortageSheets: 500, prStatus: 'pending' })
    expect(r.allReady).toBe(true)
  })
})

describe('computeReleaseGuard', () => {
  it('blocks Released when shortage and no PR', () => {
    expect(computeReleaseGuard({ shortageSheets: 10, prStatus: 'not_created' }).canRelease).toBe(false)
  })
  it('permits Released when no shortage', () => {
    expect(computeReleaseGuard({ shortageSheets: 0, prStatus: 'not_created' }).canRelease).toBe(true)
  })
  it('permits Released when shortage but PR approved', () => {
    expect(computeReleaseGuard({ shortageSheets: 10, prStatus: 'approved' }).canRelease).toBe(true)
  })
})
```

- [ ] **Step 2: Run red**

Run: `npm test -- src/components/planning/engine/planningValidation.test.ts`
Expected: FAIL — `computeReadinessFive` not exported.

- [ ] **Step 3: Implement**

```ts
// src/components/planning/engine/planningValidation.ts

export type ReadinessFiveInput = {
  ups: number | null
  sheetLengthMm: number | null
  sheetWidthMm: number | null
  boardType: string | null
  gsm: number | null
  materialSelected: boolean
  shortageSheets: number
  prStatus: string
}

export type ReadinessFive = { allReady: boolean; blockers: string[] }

const PR_ACTIVE = new Set(['pending', 'approved', 'converted_to_po'])

export function computeReadinessFive(input: ReadinessFiveInput): ReadinessFive {
  const blockers: string[] = []
  if (!input.ups || input.ups <= 0) blockers.push('UPS not set')
  if (!input.sheetLengthMm || !input.sheetWidthMm) blockers.push('Sheet size incomplete')
  if (!input.boardType || input.gsm == null) blockers.push('Board type / GSM missing')
  if (!input.materialSelected) blockers.push('No board allocated')
  if (input.shortageSheets > 0 && !PR_ACTIVE.has(input.prStatus)) {
    blockers.push('Shortage — raise PR or approval')
  }
  return { allReady: blockers.length === 0, blockers }
}

export function computeReleaseGuard(input: { shortageSheets: number; prStatus: string }): {
  canRelease: boolean
  reason: string | null
} {
  if (input.shortageSheets > 0 && !PR_ACTIVE.has(input.prStatus)) {
    return { canRelease: false, reason: 'Shortage open with no PR/approval' }
  }
  return { canRelease: true, reason: null }
}
```

- [ ] **Step 4: Run green**

Run: `npm test -- src/components/planning/engine/planningValidation.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/components/planning/engine/planningValidation.ts src/components/planning/engine/planningValidation.test.ts
git commit -m "feat(planning): add readinessFive + release-guard validation module"
```

### Task 1.2: The adapter — `buildEngineLine`

**Files:**
- Create: `src/components/planning/engine/buildEngineLine.ts`
- Test: `src/components/planning/engine/buildEngineLine.test.ts`

Synthesizes `PlanningEngineLine` from the raw grid line + the fetched readiness. Populates `upsAndSpec` (ups, sheetYieldPct, makeReady=null for now, bpi=null for now), `batchDecision` (status/layoutType/setNumber from `planningCore`, designerOptions/pressAssignment from `extras`, `readinessFive` via Task 1.1), and `smartMatch` metadata (`boardMatchConfidence`, `materialCode`, `matchedOn`, `suggestions: []` — composite suggestions arrive in Phase 4).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { buildEngineLine } from './buildEngineLine'
import type { PlanningGridLine } from '@/components/planning/PlanningDecisionGrid'
import type { PlanningEngineReadiness } from './types'

const gridLine = {
  id: 'L1', cartonId: 'C1', cartonName: 'Pizza Box 12in', cartonSize: '300x300x40',
  quantity: 20000, artworkCode: 'AW-991', coatingType: 'Gloss', otherCoating: null,
  embossingLeafing: null, paperType: 'FBB', gsm: 300, remarks: null,
  planningStatus: 'pending',
  specOverrides: {
    planningMaterialId: 'MAT-1',
    meta: { ups: 4, parentSize: '760x1020', cutsPerSheet: 2 },
    planningCore: { status: 'Ready', layoutType: 'gang', setNumber: 'SET-007' },
  },
  po: { id: 'PO1', poNumber: 'PO-555', poDate: '2026-05-01', customer: { id: 'CU1', name: 'Domino' } },
} as unknown as PlanningGridLine

const readiness = {
  materialId: 'MAT-1', materialCode: 'FBB-300-760x1020', boardType: 'FBB', boardClassification: null,
  size: '760x1020', gsm: 300, requiredSheets: 5150, availableSheets: 6000, reservedSheets: 0,
  freeSheets: 6000, incomingSheets: 0, shortageSheets: 0, prStatus: 'not_created', grnEta: null,
  status: 'green',
  suggestedBoardOptions: [
    { materialId: 'MAT-1', materialCode: 'FBB-300-760x1020', boardType: 'FBB', gsm: 300, size: '760x1020',
      freeSheets: 6000, availableSheets: 6000, requiredParentSheets: 2575, shortageParentSheets: 0,
      wastagePct: 8, yieldPct: 92, cutsPerSheet: 2, matchType: 'Direct Size', status: 'Ready',
      tags: ['Best Yield'], gsmDelta: 0 },
  ],
  closestAvailableOptions: [],
} as unknown as PlanningEngineReadiness

describe('buildEngineLine', () => {
  it('populates upsAndSpec.ups from spec meta', () => {
    const out = buildEngineLine(gridLine, readiness, {})
    expect(out.upsAndSpec?.ups).toBe(4)
  })

  it('populates batchDecision from planningCore', () => {
    const out = buildEngineLine(gridLine, readiness, {})
    expect(out.batchDecision?.status).toBe('Ready')
    expect(out.batchDecision?.layoutType).toBe('Gang')
    expect(out.batchDecision?.setNumber).toBe('SET-007')
  })

  it('enables lock when all gates pass (material selected, no shortage)', () => {
    const out = buildEngineLine(gridLine, readiness, {})
    expect(out.batchDecision?.readinessFive?.allReady).toBe(true)
  })

  it('blocks lock when no material selected', () => {
    const noMat = { ...gridLine, specOverrides: { ...(gridLine.specOverrides as object), planningMaterialId: null } } as unknown as PlanningGridLine
    const out = buildEngineLine(noMat, { ...readiness, materialId: null }, {})
    expect(out.batchDecision?.readinessFive?.allReady).toBe(false)
    expect(out.batchDecision?.readinessFive?.blockers).toContain('No board allocated')
  })

  it('passes through designer + press options from extras', () => {
    const out = buildEngineLine(gridLine, readiness, {
      designerOptions: [{ id: 'd1', name: 'Avneet' }],
      pressAssignment: { code: 'CI-02', deckLabel: '6-col', size: '1020x760', loadPct: 40, runHours: 5, smartPicked: true },
    })
    expect(out.batchDecision?.designerOptions).toHaveLength(1)
    expect(out.batchDecision?.pressAssignment?.code).toBe('CI-02')
  })

  it('sets smartMatch confidence from the top board option fit', () => {
    const out = buildEngineLine(gridLine, readiness, {})
    expect(out.smartMatch?.materialCode).toBe('FBB-300-760x1020')
    expect(out.smartMatch?.suggestions).toEqual([])
  })
})
```

- [ ] **Step 2: Run red**

Run: `npm test -- src/components/planning/engine/buildEngineLine.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/components/planning/engine/buildEngineLine.ts
import type { PlanningGridLine } from '@/components/planning/PlanningDecisionGrid'
import type { PlanningEngineLine, PlanningEngineReadiness } from './types'
import { readPlanningCore, readPlanningMeta } from '@/lib/planning-decision-spec'
import { resolveUps } from '@/lib/production-os-resolvers'
import { computeReadinessFive } from './planningValidation'

export type BuildEngineLineExtras = {
  designerOptions?: Array<{ id: string; name: string }>
  designerId?: string | null
  pressAssignment?: PlanningEngineLine extends infer _ ? NonNullable<PlanningEngineLine['batchDecision']>['pressAssignment'] : never
  /** Composite gang suggestions (Phase 4). */
  smartMatchSuggestions?: NonNullable<PlanningEngineLine['smartMatch']>['suggestions']
}

function parseSizePair(size: string | null | undefined): { l: number | null; w: number | null } {
  if (!size) return { l: null, w: null }
  const m = String(size).match(/(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)/i)
  if (!m) return { l: null, w: null }
  return { l: Number(m[1]), w: Number(m[2]) }
}

const STATUS_VALUES = ['Ready', 'Draft', 'Hold', 'ApprovedAW', 'Released', 'Locked'] as const
type BdStatus = (typeof STATUS_VALUES)[number]

export function buildEngineLine(
  line: PlanningGridLine,
  readiness: PlanningEngineReadiness | null,
  extras: BuildEngineLineExtras = {},
): PlanningEngineLine {
  const spec = (line.specOverrides ?? {}) as Record<string, unknown>
  const meta = readPlanningMeta(spec)
  const core = readPlanningCore(spec)

  const ups = (Number(meta.ups) || resolveUps(line) || null) as number | null
  const qty = Number(line.quantity ?? 0)
  const requiredSheets = Number(readiness?.requiredSheets ?? 0)
  const sheetYieldPct =
    ups && qty && requiredSheets ? Math.max(0, Math.min(100, (qty / (ups * requiredSheets)) * 100)) : null

  // Sheet size: prefer explicit meta length/width, else parse the parent size string.
  const explicitL = Number(meta.sheetLengthMm)
  const explicitW = Number(meta.sheetWidthMm)
  const fromPair = parseSizePair((meta.parentSize as string) || readiness?.size || null)
  const sheetLengthMm = Number.isFinite(explicitL) && explicitL > 0 ? explicitL : fromPair.l
  const sheetWidthMm = Number.isFinite(explicitW) && explicitW > 0 ? explicitW : fromPair.w

  const materialSelected = !!(spec.planningMaterialId || readiness?.materialId)
  const shortageSheets = Number(readiness?.shortageSheets ?? 0)
  const prStatus = readiness?.prStatus ?? 'not_created'

  const readinessFive = computeReadinessFive({
    ups,
    sheetLengthMm,
    sheetWidthMm,
    boardType: readiness?.boardType ?? line.paperType ?? null,
    gsm: readiness?.gsm ?? line.gsm ?? null,
    materialSelected,
    shortageSheets,
    prStatus,
  })

  const rawStatus = String(core.status ?? 'Draft')
  const status = (STATUS_VALUES.includes(rawStatus as BdStatus) ? rawStatus : 'Draft') as BdStatus
  const layoutType: 'Gang' | 'Single' =
    core.layoutType === 'gang' ? 'Gang' : core.layoutType === 'single' ? 'Single' : 'Single'

  const topOption =
    (readiness?.suggestedBoardOptions && readiness.suggestedBoardOptions[0]) ||
    (readiness?.closestAvailableOptions && readiness.closestAvailableOptions[0]) ||
    null

  return {
    ...(line as unknown as PlanningEngineLine),
    upsAndSpec: {
      ups,
      upsSource: meta.ups != null ? 'manual' : ups != null ? 'auto' : null,
      sheetYieldPct,
      makeReady: null, // Phase 2 populates this
      bpi: null,
    },
    smartMatch: {
      boardMatchConfidence: topOption ? Math.round(topOption.yieldPct) : 0,
      materialCode: readiness?.materialCode ?? topOption?.materialCode ?? null,
      matchedOn: topOption?.matchType ?? null,
      suggestions: extras.smartMatchSuggestions ?? [],
    },
    batchDecision: {
      status,
      layoutType,
      setNumber: (core.setNumber as string) ?? null,
      setNumberAuto: !core.setNumber,
      designerOptions: extras.designerOptions ?? [],
      designerId: extras.designerId ?? ((core.designerKey as string) || null),
      pressAssignment: extras.pressAssignment ?? null,
      readinessFive,
      lockedAt: (core.lockedAt as string) ?? null,
      lockedByName: (core.lockedByName as string) ?? null,
    },
  }
}
```

> Note: if `readPlanningCore` does not already expose `status` / `layoutType` / `setNumber` / `designerKey` / `lockedAt` / `lockedByName`, read them defensively from the raw `planningCore` object instead (the `SectionBatchDecision` persist helpers write exactly these keys via `patchPlanningCore`). Verify with: `grep -n "status\|layoutType\|setNumber\|designerKey\|lockedAt" src/lib/planning-decision-spec.ts`. If absent from the typed `PlanningCore`, replace `core.X` reads with `const pc = (spec.planningCore ?? {}) as Record<string, unknown>` and read `pc.X`.

- [ ] **Step 4: Run green**

Run: `npm test -- src/components/planning/engine/buildEngineLine.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/planning/engine/buildEngineLine.ts src/components/planning/engine/buildEngineLine.test.ts
git commit -m "feat(planning): add buildEngineLine adapter (populates engine view-model)"
```

### Task 1.3: Wire the adapter into the drawer

**Files:**
- Modify: `src/components/planning/PlanningJobDetailDrawer.tsx:1493-1502` (the `<PlanningEngineBody>` call).

- [ ] **Step 1: Add the import** near the other engine imports at the top of the file.

```tsx
import { buildEngineLine } from '@/components/planning/engine/buildEngineLine'
```

- [ ] **Step 2: Build a memoized engine line** — insert just above the `return`/JSX that renders `<PlanningEngineBody>` (near line 1490, inside the component body, after `readiness` is in scope):

```tsx
  const engineLine = useMemo(
    () =>
      line
        ? buildEngineLine(line as unknown as PlanningGridLine, readiness as unknown as PlanningEngineReadiness | null, {
            designerOptions,
            pressAssignment,
          })
        : null,
    [line, readiness, designerOptions, pressAssignment],
  )
```

> `designerOptions` and `pressAssignment` are added in Task 1.4. For this task, temporarily pass `{}`:
> ```tsx
> ? buildEngineLine(line as unknown as PlanningGridLine, readiness as unknown as PlanningEngineReadiness | null, {})
> ```
> and drop them from the dep array, then wire them in Task 1.4.

- [ ] **Step 3: Replace the cast in the JSX** — change line 1494:

```tsx
        line={line as unknown as PlanningEngineLine}
```
to:
```tsx
        line={engineLine ?? (line as unknown as PlanningEngineLine)}
```

- [ ] **Step 4: Type-check + run engine tests**

Run: `npx tsc --noEmit` (expect clean; project excludes scripts/prisma per memory)
Run: `npm test -- src/components/planning/engine/`
Expected: existing 4 section test files still PASS. The `SectionBatchDecision` "Save & lock" button is now driven by real `readinessFive`.

- [ ] **Step 5: Verify in the browser** (req-10 gate visibly works)

Start the dev server (`preview_start`), open a planning line drawer, confirm: SHEET METRICS tiles show UPS + sheet yield (not "—"), and "Save & lock" is **enabled** when a board is allocated and there's no shortage, **disabled** with a blocker reason otherwise. Capture a screenshot.

- [ ] **Step 6: Commit**

```bash
git add src/components/planning/PlanningJobDetailDrawer.tsx
git commit -m "feat(planning): feed engine sections via buildEngineLine adapter"
```

### Task 1.4: Populate designer + press options in the drawer

**Files:**
- Modify: `src/components/planning/PlanningJobDetailDrawer.tsx` (add fetch + state).

Designers come from the operator/designer master; press from machines. These feed `batchDecision.designerOptions` and `pressAssignment` so those controls (already built in `SectionBatchDecision`) stop showing "No designers configured" / "No press assigned yet."

- [ ] **Step 1: Confirm the endpoints exist**

Run: `ls src/app/api/operator-master src/app/api/machines` and `grep -rn "designer\|role" src/app/api/operator-master/route.ts | head`. Use whichever returns designer-capable operators. If a dedicated designer list isn't available, use `operator-master` filtered client-side by role containing "design".

- [ ] **Step 2: Add state + fetch** (near the other `useState`/`useEffect` around lines 355–360 / 558):

```tsx
  const [designerOptions, setDesignerOptions] = useState<Array<{ id: string; name: string }>>([])
  const [pressAssignment, setPressAssignment] =
    useState<NonNullable<PlanningEngineLine['batchDecision']>['pressAssignment']>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch('/api/operator-master?role=designer', { cache: 'no-store' })
        const data = await res.json().catch(() => ({}))
        const list = Array.isArray(data?.operators) ? data.operators : Array.isArray(data) ? data : []
        if (!cancelled) {
          setDesignerOptions(
            list
              .map((o: { id?: string; name?: string; fullName?: string }) => ({
                id: String(o.id ?? ''),
                name: String(o.name ?? o.fullName ?? ''),
              }))
              .filter((o: { id: string; name: string }) => o.id && o.name),
          )
        }
      } catch {
        if (!cancelled) setDesignerOptions([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])
```

> `pressAssignment` is populated by the smart-press logic in Phase 6; for now it stays `null` (the section already handles null gracefully). Adjust the field names (`operators` vs array) to match the actual `operator-master` response shape you confirmed in Step 1.

- [ ] **Step 3: Pass them into `buildEngineLine`** — restore the `extras` object in the `engineLine` memo (Task 1.3 Step 2) to include `{ designerOptions, pressAssignment }` and add both to the dep array.

- [ ] **Step 4: Type-check + test**

Run: `npx tsc --noEmit` and `npm test -- src/components/planning/engine/`
Expected: clean / green.

- [ ] **Step 5: Verify + commit**

Browser: the Designer segmented control now lists designers. Screenshot.
```bash
git add src/components/planning/PlanningJobDetailDrawer.tsx
git commit -m "feat(planning): supply designer options to batch decision section"
```

---

# PHASE 2 — Sheet spec fields + make-ready calc (req-2, req-3)

### Task 2.1: Extend planning meta helpers with sheet L/W/unit/cut-type/make-ready

**Files:**
- Modify: `src/lib/planning-decision-spec.ts`
- Test: extend its existing test file if present, else create `src/lib/planning-decision-spec.test.ts`.

- [ ] **Step 1: Failing test** (`src/lib/planning-decision-spec.test.ts` — add cases; if file exists, append):

```ts
import { describe, it, expect } from 'vitest'
import { readPlanningMeta, mergePlanningMetaSheetSpec } from './planning-decision-spec'

describe('sheet spec meta', () => {
  it('round-trips length/width/unit/cutType', () => {
    const spec = mergePlanningMetaSheetSpec({}, { lengthMm: 760, widthMm: 1020, unit: 'mm', cutType: 2 })
    const meta = readPlanningMeta(spec)
    expect(meta.sheetLengthMm).toBe(760)
    expect(meta.sheetWidthMm).toBe(1020)
    expect(meta.sheetUnit).toBe('mm')
    expect(meta.cutType).toBe(2)
  })
})
```

- [ ] **Step 2: Run red** → `npm test -- src/lib/planning-decision-spec.test.ts` → FAIL (no `mergePlanningMetaSheetSpec`).

- [ ] **Step 3: Implement** — add to `planning-decision-spec.ts` (mirror the existing `mergePlanningMetaUps` pattern at line 116):

```ts
export function mergePlanningMetaSheetSpec(
  spec: Record<string, unknown>,
  patch: { lengthMm?: number | null; widthMm?: number | null; unit?: 'mm' | 'inch'; cutType?: number | null; makeReadySheets?: number | null },
): Record<string, unknown> {
  const meta = { ...readPlanningMeta(spec) }
  if (patch.lengthMm !== undefined) meta.sheetLengthMm = patch.lengthMm
  if (patch.widthMm !== undefined) meta.sheetWidthMm = patch.widthMm
  if (patch.unit !== undefined) meta.sheetUnit = patch.unit
  if (patch.cutType !== undefined) meta.cutType = patch.cutType
  if (patch.makeReadySheets !== undefined) meta.makeReadySheets = patch.makeReadySheets
  // Keep parentSize string in sync so existing readers (resolveSheetSize) still work.
  if (patch.lengthMm != null && patch.widthMm != null) {
    meta.parentSize = `${patch.lengthMm}x${patch.widthMm}`
  }
  return { ...spec, meta }
}
```

- [ ] **Step 4: Run green** → PASS.
- [ ] **Step 5: Commit** → `git commit -m "feat(planning): add sheet length/width/unit/cut-type/make-ready meta helpers"`

### Task 2.2: Make-ready bucket in the calc resolver

**Files:**
- Modify: `src/lib/production-os-resolvers.ts:357-430` (`resolveRequirementFromLine`).
- Test: add to `src/lib/production-os-resolvers.test.ts` (create if missing).

Make `requiredSheets = baseSheets + makeReady + wastage`. **makeReady defaults to 0** (safe: existing lines unchanged). Source: `meta.makeReadySheets` / `planningCore.makeReadySheets`.

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from 'vitest'
import { resolveRequirementFromLine } from './production-os-resolvers'

describe('resolveRequirementFromLine make-ready', () => {
  const base = { quantity: 20000, specOverrides: { meta: { ups: 4 } } }

  it('defaults make-ready to 0 → total = base + wastage (unchanged)', () => {
    const r = resolveRequirementFromLine({ line: base, wastageOverride: 150 })
    expect(r.baseSheets).toBe(5000)
    expect(r.makeReadySheets).toBe(0)
    expect(r.requiredSheets).toBe(5150)
  })

  it('adds make-ready when present in spec', () => {
    const r = resolveRequirementFromLine({
      line: { quantity: 20000, specOverrides: { meta: { ups: 4, makeReadySheets: 200 } } },
      wastageOverride: 150,
    })
    expect(r.makeReadySheets).toBe(200)
    expect(r.requiredSheets).toBe(5350)
  })

  it('honors makeReadyOverride', () => {
    const r = resolveRequirementFromLine({ line: base, wastageOverride: 100, makeReadyOverride: 50 })
    expect(r.requiredSheets).toBe(5150) // 5000 + 50 + 100
  })
})
```

- [ ] **Step 2: Run red** → FAIL (`makeReadySheets` undefined; `makeReadyOverride` not a param).

- [ ] **Step 3: Implement** — in `resolveRequirementFromLine`:
  1. Add `makeReadyOverride?: number | null` to the input type (line 357-362).
  2. After the `wastage` computation (line 420), before the `return`, add:

```ts
    const makeReadySheets = Math.max(
      0,
      Math.floor(
        Number(
          input.makeReadyOverride ??
            specOverrides.makeReadySheets ??
            planningCore.makeReadySheets ??
            specOverridesMeta.makeReadySheets ??
            specMeta.makeReadySheets ??
            0,
        ) || 0,
      ),
    )
```
  3. Change the return object: add `makeReadySheets,` and change `requiredSheets` (line 426) to:

```ts
      requiredSheets: Math.max(1, baseSheets + makeReadySheets + wastage),
```

- [ ] **Step 4: Run green** → PASS. Also run `npm test -- src/lib/` to confirm no other resolver test regressed.
- [ ] **Step 5: Commit** → `git commit -m "feat(planning): add separate make-ready sheet bucket to requirement calc"`

### Task 2.3: Thread make-ready through the readiness route + adapter

**Files:**
- Modify: `src/app/api/planning/po-lines/[id]/reserve-material/route.ts` (GET calc + response).
- Modify: `src/components/planning/engine/buildEngineLine.ts` (populate `upsAndSpec.makeReady` + expected-yield/balance fields).
- Modify: `src/components/planning/engine/types.ts`.

- [ ] **Step 1: types.ts** — extend `upsAndSpec` and add a `sheetSpec` block. Replace the `upsAndSpec` block (lines 59-70) with:

```ts
  upsAndSpec?: {
    ups: number | null
    upsSource: 'auto' | 'manual' | null
    sheetYieldPct: number | null
    makeReady?: { total: number; base: number; colours?: { count: number; perColour: number } | null; uv?: number | null } | null
    bpi?: { status: 'Optimal' | 'Suboptimal'; marginInr: number; setupInr: number } | null
    /** Allocated sheets × UPS (req-3 expected yield). */
    expectedYieldUnits?: number | null
    /** Allocated/free sheets − total required (req-3 balance after allocation). */
    balanceAfterAllocation?: number | null
  }
  sheetSpec?: {
    lengthMm: number | null
    widthMm: number | null
    unit: 'mm' | 'inch'
    cutType: number | null
    parentSize: string | null
    childSize: string | null
  }
```

- [ ] **Step 2: readiness route** — in the GET handler (around the calc, lines 583-656 response), ensure `requiredSheets` already uses the resolver (it should, via `resolveRequirementFromLine`). Add `makeReadySheets` and `requiredFinalSize` (child size — already present at line 609) to the response object:

```ts
    makeReadySheets: requirement.makeReadySheets ?? 0,
```
(Use whatever variable holds the `resolveRequirementFromLine` result; grep for `resolveRequirementFromLine(` in the route. If the route computes sheets inline instead, switch it to call the resolver so the formula matches Phase 2.2.)

- [ ] **Step 3: buildEngineLine** — populate make-ready, expected-yield, balance, and sheetSpec. After computing `requiredSheets` add:

```ts
  const makeReadySheets = Number(meta.makeReadySheets ?? (readiness as { makeReadySheets?: number } | null)?.makeReadySheets ?? 0)
  const allocatedSheets = Number(readiness?.reservedSheets ?? 0) || Number(readiness?.freeSheets ?? 0)
  const expectedYieldUnits = ups && allocatedSheets ? allocatedSheets * ups : null
  const balanceAfterAllocation = readiness ? Number(readiness.freeSheets ?? readiness.availableSheets ?? 0) - requiredSheets : null
  const childSize = (readiness as { requiredFinalSize?: string | null } | null)?.requiredFinalSize ?? null
```
Then set `upsAndSpec.makeReady` to `makeReadySheets > 0 ? { total: makeReadySheets, base: makeReadySheets } : null`, add `expectedYieldUnits` and `balanceAfterAllocation`, and add the `sheetSpec` block:

```ts
    sheetSpec: {
      lengthMm: sheetLengthMm,
      widthMm: sheetWidthMm,
      unit: (meta.sheetUnit as 'mm' | 'inch') ?? 'mm',
      cutType: meta.cutType != null ? Number(meta.cutType) : (Number(meta.cutsPerSheet) || null),
      parentSize: (meta.parentSize as string) ?? readiness?.size ?? null,
      childSize,
    },
```

- [ ] **Step 4: Extend buildEngineLine.test.ts** with assertions for `sheetSpec.lengthMm/widthMm/cutType`, `upsAndSpec.expectedYieldUnits`, `upsAndSpec.balanceAfterAllocation`. Run red → implement (already done in Step 3) → green.

- [ ] **Step 5: Commit** → `git commit -m "feat(planning): thread make-ready, expected-yield, balance, sheet-spec into view-model"`

### Task 2.4: Replace the single "Sheet size" field with Length/Width/Unit + Cut-type + Child-size

**Files:**
- Modify: `src/components/planning/engine/SectionBoardAllocation.tsx` (Row 1 block, lines ~435-458).
- Test: extend `SectionBoardAllocation.test.tsx`.

Keep the existing `EditableTile`/`ReadOnlyTile` components and grid. Replace the one "Sheet size" `EditableTile` (lines 435-442) with three tiles (Length, Width, Unit) + a Cut-type selector tile, and add a read-only Child-size tile. UPS tile (443-458) stays.

- [ ] **Step 1: Failing test** — add to `SectionBoardAllocation.test.tsx`:

```tsx
it('renders separate sheet length, width, unit and cut-type fields', () => {
  const line = { ...baseLine, sheetSpec: { lengthMm: 760, widthMm: 1020, unit: 'mm', cutType: 2, parentSize: '760x1020', childSize: '300x400' } } as unknown as PlanningEngineLine
  render(<SectionBoardAllocation line={line} readiness={null} readinessLoading={false} onPatch={async () => true} />)
  expect(screen.getByLabelText('Sheet length')).toBeInTheDocument()
  expect(screen.getByLabelText('Sheet width')).toBeInTheDocument()
  expect(screen.getByLabelText('Sheet unit')).toBeInTheDocument()
  expect(screen.getByLabelText('Cut type')).toBeInTheDocument()
})
```
(Reuse the existing `baseLine` in that test file; add a `sheetSpec` to it.)

- [ ] **Step 2: Run red** → FAIL.

- [ ] **Step 3: Implement.** Add a `sheetSpec` read + drafts near the existing `drafts` state (line ~250) and `commitSize` (line 342). Replace the single `EditableTile label="Sheet size"` (435-442) with:

```tsx
        <EditableTile
          label="Sheet length"
          ariaLabel="Sheet length"
          type="number"
          value={drafts.sheetLength}
          placeholder="—"
          onChange={(v) => setDrafts((d) => ({ ...d, sheetLength: v }))}
          onCommit={commitSheetSpec}
        />
        <EditableTile
          label="Sheet width"
          ariaLabel="Sheet width"
          type="number"
          value={drafts.sheetWidth}
          placeholder="—"
          onChange={(v) => setDrafts((d) => ({ ...d, sheetWidth: v }))}
          onCommit={commitSheetSpec}
        />
```
Then add a Unit selector and Cut-type selector. Since `EditableTile` is text/number only, render two small `<select>` tiles styled like the existing tiles (copy the tile wrapper classes from `EditableTile` lines 86-127). Add after the width tile:

```tsx
        <div className="bg-ds-elevated rounded-ds-md border border-ds-line/40 p-3">
          <label htmlFor="sheet-unit" className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint">Sheet unit</label>
          <select
            id="sheet-unit"
            aria-label="Sheet unit"
            value={drafts.sheetUnit}
            onChange={(e) => { setDrafts((d) => ({ ...d, sheetUnit: e.target.value })); commitSheetSpec() }}
            className="mt-1 w-full bg-ds-elevated border border-ds-line/40 rounded-ds-md px-2 py-1 text-sm font-semibold text-ds-ink outline-none"
          >
            <option value="mm">mm</option>
            <option value="inch">inch</option>
          </select>
        </div>
        <div className="bg-ds-elevated rounded-ds-md border border-ds-line/40 p-3">
          <label htmlFor="cut-type" className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint">Cut type</label>
          <select
            id="cut-type"
            aria-label="Cut type"
            value={drafts.cutType}
            onChange={(e) => { setDrafts((d) => ({ ...d, cutType: e.target.value })); commitSheetSpec() }}
            className="mt-1 w-full bg-ds-elevated border border-ds-line/40 rounded-ds-md px-2 py-1 text-sm font-semibold text-ds-ink outline-none"
          >
            {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}-cut</option>)}
          </select>
        </div>
        <ReadOnlyTile label="Child sheet size" value={line.sheetSpec?.childSize ?? '—'} />
```
Add the `commitSheetSpec` handler (mirroring `commitSize` at 342, using `mergePlanningMetaSheetSpec` from Task 2.1):

```tsx
  const commitSheetSpec = useCallback(() => {
    const lengthMm = drafts.sheetLength ? Number(drafts.sheetLength) : null
    const widthMm = drafts.sheetWidth ? Number(drafts.sheetWidth) : null
    const cutType = drafts.cutType ? Number(drafts.cutType) : null
    const unit = (drafts.sheetUnit === 'inch' ? 'inch' : 'mm') as 'mm' | 'inch'
    void onPatch({ specOverrides: mergePlanningMetaSheetSpec({ ...(line.specOverrides ?? {}) }, { lengthMm, widthMm, unit, cutType }) })
  }, [drafts, line.specOverrides, onPatch])
```
Initialise `drafts` with `sheetLength`, `sheetWidth`, `sheetUnit`, `cutType` from `line.sheetSpec`. Import `mergePlanningMetaSheetSpec` from `@/lib/planning-decision-spec`. The Row-1 grid is `grid-cols-2 lg:grid-cols-4`; with more tiles it wraps cleanly into additional rows — no layout class change needed.

- [ ] **Step 4: Run green** → `npm test -- src/components/planning/engine/SectionBoardAllocation.test.tsx` → PASS.
- [ ] **Step 5: Browser verify** — open drawer, confirm Length/Width/Unit/Cut-type render and persist (reopen drawer → values retained). Screenshot.
- [ ] **Step 6: Commit** → `git commit -m "feat(planning): split sheet size into length/width/unit + cut-type + child-size"`

### Task 2.5: Add Make-ready / Expected-yield / Balance tiles to SHEET METRICS

**Files:**
- Modify: `src/components/planning/engine/SectionUpsAndSpec.tsx` (grid at lines 60-101).
- Test: extend `SectionUpsAndSpec.test.tsx`.

- [ ] **Step 1: Failing test** — add a line with `upsAndSpec.expectedYieldUnits`, `balanceAfterAllocation`, `makeReady` and assert the tiles render those values.

```tsx
it('renders expected yield and balance tiles', () => {
  const line = { ...baseLine, upsAndSpec: { ups: 4, upsSource: 'manual', sheetYieldPct: 90, makeReady: { total: 200, base: 200 }, bpi: null, expectedYieldUnits: 24000, balanceAfterAllocation: 850 } } as unknown as PlanningEngineLine
  render(<SectionUpsAndSpec line={line} onPatch={async () => true} />)
  expect(screen.getByText('Expected yield')).toBeInTheDocument()
  expect(screen.getByText('Balance after alloc.')).toBeInTheDocument()
})
```

- [ ] **Step 2: Run red** → FAIL.
- [ ] **Step 3: Implement** — read the new fields (`const expectedYield = line.upsAndSpec?.expectedYieldUnits; const balance = line.upsAndSpec?.balanceAfterAllocation`) and add two more `<MetricTile>` entries inside the existing `grid grid-cols-2` (after the BPI tile, line ~100):

```tsx
        <MetricTile
          label="Expected yield"
          value={expectedYield != null ? `${nf.format(expectedYield)} pcs` : '—'}
          hint="Allocated sheets × UPS"
        />
        <MetricTile
          label="Balance after alloc."
          value={balance != null ? `${nf.format(balance)} sh` : '—'}
          emphasisClass={balance != null && balance < 0 ? 'text-red-300' : 'text-ds-ink'}
        />
```
(Make-ready tile already exists at lines 79-91 and now shows data thanks to Phase 2.3.)

- [ ] **Step 4: Run green** → PASS.
- [ ] **Step 5: Commit** → `git commit -m "feat(planning): show make-ready, expected-yield and balance in sheet metrics"`

---

# PHASE 3 — Product identity header + section reorder (req-1, req-9)

### Task 3.1: SectionProductRequirement (Section 1)

**Files:**
- Create: `src/components/planning/engine/SectionProductRequirement.tsx`
- Test: `src/components/planning/engine/SectionProductRequirement.test.tsx`

A read-only `CardSection title="PRODUCT REQUIREMENT"` showing req-1 identity: Customer PO No., Product Name, Product/AW Code, Customer Name, Board Type, GSM, Final Carton Size, Required Quantity, Current Status. All data already lives on the line/readiness.

- [ ] **Step 1: Failing test**

```tsx
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { SectionProductRequirement } from './SectionProductRequirement'
import type { PlanningEngineLine, PlanningEngineReadiness } from './types'

const line = {
  id: 'L1', cartonName: 'Pizza Box 12in', cartonSize: '300x300x40', quantity: 20000,
  artworkCode: 'AW-991', paperType: 'FBB', gsm: 300, planningStatus: 'pending',
  specOverrides: null, po: { id: 'PO1', poNumber: 'PO-555', poDate: '2026-05-01', customer: { id: 'CU1', name: 'Domino' } },
} as unknown as PlanningEngineLine
const readiness = { boardType: 'FBB', gsm: 300 } as unknown as PlanningEngineReadiness

describe('SectionProductRequirement', () => {
  it('shows PO, product, AW code, customer, board, gsm, carton size, qty, status', () => {
    render(<SectionProductRequirement line={line} readiness={readiness} />)
    expect(screen.getByText('PO-555')).toBeInTheDocument()
    expect(screen.getByText('Pizza Box 12in')).toBeInTheDocument()
    expect(screen.getByText('AW-991')).toBeInTheDocument()
    expect(screen.getByText('Domino')).toBeInTheDocument()
    expect(screen.getByText(/FBB/)).toBeInTheDocument()
    expect(screen.getByText(/300/)).toBeInTheDocument()
    expect(screen.getByText('300x300x40')).toBeInTheDocument()
    expect(screen.getByText(/20,000/)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run red** → FAIL.
- [ ] **Step 3: Implement** — reuse `CardSection` + the `ReadOnlyTile` look (or a small definition-list). Use `Intl.NumberFormat('en-IN')` for qty. Render a `grid grid-cols-2 lg:grid-cols-3 gap-3` of label/value pairs styled with the same `text-[11px] uppercase ... text-ds-ink-faint` label class used elsewhere.

```tsx
import { memo } from 'react'
import { CardSection } from '@/components/design-system/CardSection'
import type { PlanningEngineLine, PlanningEngineReadiness } from './types'

const nf = new Intl.NumberFormat('en-IN')

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint">{label}</div>
      <div className="text-sm font-semibold text-ds-ink mt-0.5 truncate">{value ?? '—'}</div>
    </div>
  )
}

export const SectionProductRequirement = memo(function SectionProductRequirement({
  line,
  readiness,
}: {
  line: PlanningEngineLine
  readiness: PlanningEngineReadiness | null
}) {
  return (
    <CardSection title="PRODUCT REQUIREMENT">
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <Field label="Customer PO" value={line.po?.poNumber} />
        <Field label="Product" value={line.cartonName} />
        <Field label="Product / AW code" value={line.artworkCode} />
        <Field label="Customer" value={line.po?.customer?.name} />
        <Field label="Board type" value={readiness?.boardType ?? line.paperType} />
        <Field label="GSM" value={(readiness?.gsm ?? line.gsm) != null ? String(readiness?.gsm ?? line.gsm) : '—'} />
        <Field label="Final carton size" value={line.cartonSize} />
        <Field label="Required qty" value={line.quantity != null ? nf.format(line.quantity) : '—'} />
        <Field label="Status" value={line.planningStatus} />
      </div>
    </CardSection>
  )
})
```

- [ ] **Step 4: Run green** → PASS.
- [ ] **Step 5: Commit** → `git commit -m "feat(planning): add Product Requirement section (req-1 identity)"`

### Task 3.2: SectionWarehouseAvailability (Section 3)

**Files:**
- Create: `src/components/planning/engine/SectionWarehouseAvailability.tsx`
- Test: `src/components/planning/engine/SectionWarehouseAvailability.test.tsx`

A `CardSection title="WAREHOUSE AVAILABILITY"` that surfaces available / reserved / free / shortage + selected board, and hosts the **Open warehouse** button (wired to the popup in Phase 5). Reuse `WarehouseStrip` (currently inside `SectionBoardAllocation`) — extract nothing; just render the same numbers from `readiness`.

- [ ] **Step 1: Failing test** — render with a readiness having `availableSheets/reservedSheets/freeSheets/shortageSheets` and assert all four labels + an "Open warehouse" button (with an `onOpenWarehouse` spy fired on click).

- [ ] **Step 2: Run red** → FAIL.
- [ ] **Step 3: Implement** — a 4-tile grid (Available / Reserved / Free / Shortage) using the existing tile classes, the selected board line (`readiness.materialCode`), and a button:

```tsx
{onOpenWarehouse ? (
  <button type="button" onClick={onOpenWarehouse}
    className="rounded-full border border-ds-line/40 bg-ds-elevated px-3 py-1 text-xs font-semibold text-ds-ink hover:border-ds-brand/50 transition-colors">
    Open warehouse
  </button>
) : null}
```
Props: `{ readiness: PlanningEngineReadiness | null; onOpenWarehouse?: () => void }`.

- [ ] **Step 4: Run green** → PASS.
- [ ] **Step 5: Commit** → `git commit -m "feat(planning): add Warehouse Availability section (req-9 section 3)"`

### Task 3.3: Mount the two new sections in PlanningEngineBody (spec order)

**Files:**
- Modify: `src/components/planning/engine/PlanningEngineBody.tsx`

Req-9 order: Section 1 Product Requirement → Section 2 Board Allocation → Section 3 Warehouse Availability → Section 4 Smart Match → Section 5 Batch Decision. Keep the existing components; just reorder + insert. Add `onOpenWarehouse` to the body props and pass through.

- [ ] **Step 1: Failing test** (`PlanningEngineBody.test.tsx`, create if missing) — render with a populated line and assert all five section titles appear in DOM order: PRODUCT REQUIREMENT, BOARD ALLOCATION, WAREHOUSE AVAILABILITY, SMART MATCH (or its title), SHEET METRICS/BATCH DECISION. (Match the actual `CardSection` titles.)

- [ ] **Step 2: Run red** → FAIL.
- [ ] **Step 3: Implement** — new body JSX:

```tsx
    <div className="space-y-4">
      <SectionProductRequirement line={line} readiness={readiness} />
      <SectionBoardAllocation line={line} readiness={readiness} readinessLoading={readinessLoading} onPatch={onPatch} onSelectBoard={onSelectBoard} onReserve={onReserve} onRaisePR={onRaisePR} />
      <SectionWarehouseAvailability readiness={readiness} onOpenWarehouse={onOpenWarehouse} />
      <SectionSmartMatch line={line} readiness={readiness} onPatch={onPatch} onSelectBoard={onSelectBoard} />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SectionUpsAndSpec line={line} onPatch={onPatch} />
        <SectionBatchDecision line={line} onPatch={onPatch} onLock={onLock} />
      </div>
    </div>
```
Add `onOpenWarehouse?: () => void` to `PlanningEngineBodyProps` and the imports for the two new sections.

> Keep `SectionUpsAndSpec`+`SectionBatchDecision` as the existing 2-col grid (that *is* the Batch Decision area / Section 5; sheet metrics live beside it). This honors the spec order without breaking the proven 2-col layout.

- [ ] **Step 4: Run green** → PASS. Browser: confirm the five sections render top-to-bottom in order with no visual breakage. Screenshot.
- [ ] **Step 5: Commit** → `git commit -m "feat(planning): order engine into the 5 spec sections"`

---

# PHASE 4 — Smart Match: composite scoring engine + card detail (req-4)

The single-board ranking already exists (readiness `suggestedBoardOptions`, rendered by `BoardOptionCard`). Two gaps: (a) per-card **Match Score %**, **Reason**, and semantic **#1–#5 rank labels**; (b) the **composite gang suggestions** (`smartMatch.suggestions`) that combine compatible sibling PO lines with size/waste/urgency/tool sub-scores.

### Task 4.1: Match Score %, Reason & rank labels on board cards

**Files:**
- Modify: `src/components/planning/engine/types.ts` (`PlanningEngineBoardOption`: add `matchScorePct?: number; reason?: string`).
- Modify: `src/app/api/planning/po-lines/[id]/reserve-material/route.ts` (compute `matchScorePct` from `fitScore`, build `reason` string per option).
- Modify: `src/components/planning/engine/SectionSmartMatch.tsx` (`BoardOptionCard`: show score%, reason, and a semantic rank label).
- Test: extend `SectionSmartMatch.test.tsx`.

- [ ] **Step 1: types.ts** — add to `PlanningEngineBoardOption` (after `gsmDelta`, line 49): `matchScorePct?: number | null` and `reason?: string | null`.

- [ ] **Step 2: route** — where options are finalized (after `withBoardMatchMode`, ~line 491), map each option to add:

```ts
        matchScorePct: Math.round(Math.max(0, Math.min(100, Number(o.fitScore) || 0))),
        reason: [
          o.matchType,
          o.gsmDelta === 0 ? 'exact GSM' : o.gsmDelta != null ? `${o.gsmDelta}g off` : null,
          `${Math.round(o.yieldPct)}% yield`,
          o.shortageParentSheets > 0 ? `short ${o.shortageParentSheets} sh` : 'in stock',
        ].filter(Boolean).join(' · '),
```
(`fitScore` is the existing weighted composite from `resolveFitScore`, `production-os-resolvers.ts:290`.)

- [ ] **Step 3: SectionSmartMatch failing test** — render with a board option carrying `matchScorePct: 87, reason: 'Direct Size · exact GSM · 92% yield · in stock'` and assert `screen.getByText('87%')` and the reason text appear; assert the rank label for rank 1 reads `Best match`.

- [ ] **Step 4: Run red** → FAIL.
- [ ] **Step 5: Implement** in `BoardOptionCard` (lines 175-216): replace the header `#{rank} · {boardLabel}` with a semantic label + score, and add the reason line:

```tsx
const RANK_LABEL = ['Best match', 'Lowest wastage', 'Closest GSM', 'Most available', 'Manual review'] as const

// inside BoardOptionCard header:
          <div className="text-sm font-semibold text-ds-ink truncate">
            #{rank} · {RANK_LABEL[rank - 1] ?? 'Option'} · {boardLabel}
          </div>
// add to the right pill area:
          {opt.matchScorePct != null ? (
            <span className="inline-flex shrink-0 items-center rounded-full border border-ds-line/40 bg-ds-elevated px-2 py-0.5 text-[11px] font-semibold tabular-nums text-ds-ink">
              {opt.matchScorePct}%
            </span>
          ) : null}
// after the chip row (after line 211), add:
      {opt.reason ? <div className="text-xs text-ds-ink-faint mb-2">{opt.reason}</div> : null}
```

- [ ] **Step 6: Run green** → PASS. Browser: cards now show rank label + score% + reason. Screenshot.
- [ ] **Step 7: Commit** → `git commit -m "feat(planning): add match score %, reason and rank labels to board cards"`

### Task 4.2: Gang-candidates endpoint

**Files:**
- Create: `src/app/api/planning/po-lines/[id]/gang-candidates/route.ts`

Returns sibling pending planning lines that are *compatible* enough to gang with this line (same board type + GSM within tolerance + same coating + same print side), each with the data the scorer needs (qty, ups, sheet size, delivery date, press hint).

- [ ] **Step 1: Failing test** — create `route.test.ts` only if the project tests routes (check for an existing `*/route.test.ts`; if none, skip the route test and rely on the scorer unit test in 4.3). If route tests exist, mock `db.poLineItem.findMany` and assert the response filters by board+gsm.

- [ ] **Step 2: Implement** — query `db.poLineItem.findMany` for `planningStatus: 'pending'`, exclude `id`, select `id, quantity, cartonName, coatingType, gsm, paperType, specOverrides, po { poNumber, deliveryRequiredBy }`. Return the array. Keep it thin — the *scoring* lives in the pure lib (4.3) so it's unit-testable.

- [ ] **Step 3: Commit** → `git commit -m "feat(planning): add gang-candidates endpoint for smart match"`

### Task 4.3: Composite scoring engine `lib/planning-smart-match.ts`

**Files:**
- Create: `src/lib/planning-smart-match.ts`
- Test: `src/lib/planning-smart-match.test.ts`

Pure function `scoreGangSuggestions(anchor, candidates, config)` → ranked `suggestions[]` matching the `smartMatch.suggestions` shape in `types.ts` (label, tier, composite, sizeScore, wasteScore, urgencyScore, toolScore, poRefs, linesIncluded, totalPcs, avgYieldPct, totalSheets). Composite = weighted average; tier from composite thresholds; sorted desc, labelled #1..#5.

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from 'vitest'
import { scoreGangSuggestions } from './planning-smart-match'

const anchor = { id: 'A', quantity: 10000, ups: 4, sheetSize: '760x1020', gsm: 300, boardType: 'FBB', coating: 'gloss', printSide: 'single', deliveryDays: 5, yieldPct: 90 }
const cands = [
  { id: 'B', quantity: 8000, ups: 4, sheetSize: '760x1020', gsm: 300, boardType: 'FBB', coating: 'gloss', printSide: 'single', deliveryDays: 6, yieldPct: 88, poRef: 'PO-2' },
  { id: 'C', quantity: 5000, ups: 2, sheetSize: '500x700', gsm: 350, boardType: 'SBS', coating: 'matt', printSide: 'double', deliveryDays: 30, yieldPct: 60, poRef: 'PO-3' },
]

describe('scoreGangSuggestions', () => {
  it('ranks the compatible sibling above the incompatible one', () => {
    const out = scoreGangSuggestions(anchor, cands, {})
    expect(out.length).toBeGreaterThan(0)
    expect(out[0].label).toBe('#1')
    expect(out[0].poRefs).toContain('PO-2')
    expect(out[0].composite).toBeGreaterThan(out[out.length - 1].composite)
  })

  it('caps at five suggestions and labels them #1..#5', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ ...cands[0], id: `X${i}`, poRef: `PO-${i}` }))
    const out = scoreGangSuggestions(anchor, many, {})
    expect(out.length).toBeLessThanOrEqual(5)
    expect(out.map((s) => s.label)).toEqual(out.map((_, i) => `#${i + 1}`))
  })

  it('scores size match high when sheet sizes equal', () => {
    const out = scoreGangSuggestions(anchor, [cands[0]], {})
    expect(out[0].sizeScore).toBeGreaterThanOrEqual(90)
  })
})
```

- [ ] **Step 2: Run red** → FAIL.
- [ ] **Step 3: Implement**

```ts
// src/lib/planning-smart-match.ts

export type GangLine = {
  id: string
  quantity: number
  ups: number
  sheetSize: string | null
  gsm: number | null
  boardType: string | null
  coating: string | null
  printSide: string | null
  deliveryDays: number | null
  yieldPct: number
  poRef?: string
}

export type GangConfig = {
  gsmTolerance?: number
  weights?: { size: number; waste: number; urgency: number; tool: number }
}

export type GangSuggestion = {
  label: string
  tier: 'High' | 'Medium' | 'Low'
  composite: number
  sizeScore: number
  wasteScore: number
  urgencyScore: number
  toolScore: number
  poRefs: string[]
  linesIncluded: number
  totalPcs: number
  avgYieldPct: number
  totalSheets: number
}

const norm = (s: string | null | undefined) => String(s ?? '').trim().toLowerCase()

function sizeScore(a: string | null, b: string | null): number {
  if (!a || !b) return 0
  return norm(a) === norm(b) ? 100 : 40 // exact vs loosely-compatible
}

export function scoreGangSuggestions(anchor: GangLine, candidates: GangLine[], config: GangConfig): GangSuggestion[] {
  const gsmTol = config.gsmTolerance ?? 10
  const w = config.weights ?? { size: 0.35, waste: 0.3, urgency: 0.2, tool: 0.15 }

  const scored = candidates
    .map((c) => {
      const size = sizeScore(anchor.sheetSize, c.sheetSize)
      const gsmOk = anchor.gsm != null && c.gsm != null && Math.abs(anchor.gsm - c.gsm) <= gsmTol
      const boardOk = norm(anchor.boardType) === norm(c.boardType)
      const coatOk = norm(anchor.coating) === norm(c.coating)
      const sideOk = norm(anchor.printSide) === norm(c.printSide)
      const tool = (boardOk ? 40 : 0) + (gsmOk ? 25 : 0) + (coatOk ? 20 : 0) + (sideOk ? 15 : 0)
      const waste = Math.max(0, Math.min(100, (anchor.yieldPct + c.yieldPct) / 2))
      const dd = c.deliveryDays ?? 999
      const urgency = dd <= 7 ? 100 : dd <= 14 ? 70 : dd <= 30 ? 40 : 10
      const composite = size * w.size + waste * w.waste + urgency * w.urgency + tool * w.tool
      const totalPcs = anchor.quantity + c.quantity
      const avgYieldPct = (anchor.yieldPct + c.yieldPct) / 2
      const totalSheets =
        Math.ceil(anchor.quantity / Math.max(1, anchor.ups)) + Math.ceil(c.quantity / Math.max(1, c.ups))
      return { c, size, waste, urgency, tool, composite, totalPcs, avgYieldPct, totalSheets }
    })
    .filter((s) => s.tool > 0) // must share at least board OR be partially compatible
    .sort((a, b) => b.composite - a.composite)
    .slice(0, 5)

  return scored.map((s, i) => ({
    label: `#${i + 1}`,
    tier: s.composite >= 75 ? 'High' : s.composite >= 50 ? 'Medium' : 'Low',
    composite: Number(s.composite.toFixed(1)),
    sizeScore: Math.round(s.size),
    wasteScore: Math.round(s.waste),
    urgencyScore: Math.round(s.urgency),
    toolScore: Math.round(s.tool),
    poRefs: [s.c.poRef].filter(Boolean) as string[],
    linesIncluded: 2,
    totalPcs: s.totalPcs,
    avgYieldPct: Number(s.avgYieldPct.toFixed(1)),
    totalSheets: s.totalSheets,
  }))
}
```

- [ ] **Step 4: Run green** → PASS.
- [ ] **Step 5: Commit** → `git commit -m "feat(planning): add composite gang smart-match scoring engine"`

### Task 4.4: Feed gang suggestions into the drawer → adapter → SmartMatch UI

**Files:**
- Modify: `src/components/planning/PlanningJobDetailDrawer.tsx` (fetch gang-candidates, call scorer, pass via `buildEngineLine` extras).
- The `SectionSmartMatch` UI for `smartMatch.suggestions` already exists (renders `.slice(0,3)`). Bump it to `.slice(0,5)` (line 288) to honor #1–#5.

- [ ] **Step 1:** In the drawer, add a `useEffect` that fetches `/api/planning/po-lines/${line.id}/gang-candidates`, maps the response + the anchor line into `GangLine` shapes, calls `scoreGangSuggestions`, and stores `gangSuggestions` in state. Pass `smartMatchSuggestions: gangSuggestions` into the `buildEngineLine` extras (and dep array).
- [ ] **Step 2:** In `SectionSmartMatch.tsx:288`, change `scored.slice(0, 3)` → `scored.slice(0, 5)`.
- [ ] **Step 3:** Extend `SectionSmartMatch.test.tsx`: provide `line.smartMatch.suggestions` of length 5 and assert all five "Suggestion #n" cards render.
- [ ] **Step 4: Run** `npm test -- src/components/planning/engine/SectionSmartMatch.test.tsx` → PASS. Browser verify the composite cards render when sibling lines exist. Screenshot.
- [ ] **Step 5: Commit** → `git commit -m "feat(planning): wire composite gang suggestions into smart match section"`

---

# PHASE 5 — Warehouse popup + reserve/unreserve + PR completeness (req-5, req-6, req-7, req-8)

### Task 5.1: WarehousePopup component

**Files:**
- Create: `src/components/planning/engine/WarehousePopup.tsx`
- Test: `src/components/planning/engine/WarehousePopup.test.tsx`

A modal (reuse the project's modal primitive — check `GlobalPopoutModal` per recent commits: `grep -rn "GlobalPopoutModal" src/components | head`) with tabs: **Full stock · Filtered matching · Suggested only · Reserved · Free**. Data: fetch `/api/inventory/paper-warehouse` for full/free/reserved; use `readiness.suggestedBoardOptions` for "suggested"; "filtered matching" = full stock filtered by the line's board type + GSM±tolerance.

- [ ] **Step 1: Failing test** — render open with mocked rows + a `readiness`; assert the five tab buttons exist and clicking "Suggested only" shows the suggested material code.
- [ ] **Step 2: Run red** → FAIL.
- [ ] **Step 3: Implement** — use `GlobalPopoutModal` (centered modal, per design-system) as the shell; a `useState` tab; a `fetch('/api/inventory/paper-warehouse')` on open; render rows in the existing table style. Props: `{ open, onClose, lineBoardType, lineGsm, readiness, onReserve, onUnreserve }`.
- [ ] **Step 4: Run green** → PASS.
- [ ] **Step 5: Commit** → `git commit -m "feat(planning): add warehouse popup (full/filtered/suggested/reserved/free)"`

### Task 5.2: Open the popup from the engine

**Files:**
- Modify: `src/components/planning/PlanningJobDetailDrawer.tsx` (state `warehousePopupOpen`; render `<WarehousePopup>`; pass `onOpenWarehouse={() => setWarehousePopupOpen(true)}` down through `PlanningEngineBody`).

- [ ] **Step 1:** add state + render the popup; wire `onOpenWarehouse` into the `<PlanningEngineBody>` props (added in Task 3.3).
- [ ] **Step 2:** Browser verify: "Open warehouse" in Section 3 opens the popup with the five tabs. Screenshot.
- [ ] **Step 3: Commit** → `git commit -m "feat(planning): open warehouse popup from engine warehouse section"`

### Task 5.3: Re-home Unreserve / Adjust into the live engine

**Files:**
- Modify: `src/components/planning/engine/SectionBoardAllocation.tsx` (add an Unreserve button beside Reserve when `reserved > 0`).
- Modify: `src/components/planning/engine/PlanningEngineBody.tsx` + `SectionBoardAllocation` props (add `onUnreserve?`).
- Modify: `src/components/planning/PlanningJobDetailDrawer.tsx` (add `handleEngineUnreserve` that calls the existing reservation-control 'release'/'adjust' API — the modal/logic already exists in the dead block; reuse the `reservation-control` endpoint).

- [ ] **Step 1: Failing test** in `SectionBoardAllocation.test.tsx`: with `readiness.reservedSheets > 0` and an `onUnreserve` spy, assert an "Unreserve" button renders and fires the spy.
- [ ] **Step 2: Run red** → FAIL.
- [ ] **Step 3: Implement** — add the button in the emerald "stock covers" banner (lines 597-617) next to Reserve:

```tsx
{reserved > 0 && onUnreserve ? (
  <button type="button" onClick={() => void onUnreserve()}
    className="ml-2 rounded-full border border-ds-line/40 bg-ds-elevated px-3 py-1 text-xs font-semibold text-ds-ink hover:border-red-400/50 transition-colors">
    Unreserve
  </button>
) : null}
```
Thread `onUnreserve` from body → section. In the drawer, `handleEngineUnreserve` POSTs to the existing reservation-control endpoint with `action: 'release'` (confirm path: `grep -rn "reservation-control" src/app/api`). Reload readiness after.

- [ ] **Step 4: Run green** → PASS. Browser: reserve then unreserve a line; confirm reserved/free numbers flip back. Screenshot the network call.
- [ ] **Step 5: Commit** → `git commit -m "feat(planning): add unreserve control to live engine board allocation"`

### Task 5.4: Make Raise PR self-sufficient + record planner name on reserve (req-6, req-8)

**Files:**
- Modify: `src/app/api/planning/po-lines/[id]/reserve-material/route.ts` (POST: capture acting user name onto the stock movement / reservation; ensure a shortage record is created so a PR can always be raised).
- Modify: `src/components/planning/PlanningJobDetailDrawer.tsx:1403` (`handleEngineRaisePR`): if `readiness.shortageId` is absent but `shortageSheets > 0`, first POST a reserve (which creates the shortage) or call a new "ensure-shortage" path, then create the PR.

- [ ] **Step 1:** In the reserve POST, the acting user is available via `requireAuth()`. Pass the user's name into `reserveMaterialForPlanning` / the stock movement create (add a `reservedByName` arg). This satisfies req-6 traceability (planner name). Add a unit test in the service test file asserting the movement carries the name. (Schema change in Task 5.5.)
- [ ] **Step 2:** `handleEngineRaisePR` — change the early-return (line 1404-1408) to attempt shortage creation first:

```tsx
  const handleEngineRaisePR = useCallback(async () => {
    let sid = readiness?.shortageId
    if (!sid && (readiness?.shortageSheets ?? 0) > 0) {
      // create the shortage by attempting a reserve of the full requirement
      await handleReserveMaterial?.() // or a dedicated ensure-shortage call
      await loadReadiness()
      sid = (/* re-read */ readinessRef.current?.shortageId) ?? null
    }
    if (!sid) { toast.error('No shortage to raise a PR for.'); return }
    // …existing POST to /api/material-shortages/${sid}/create-pr …
  }, [/* deps */])
```
(Use whichever reserve helper exists; if simpler, add a tiny `POST .../reserve-material` with `actionType: 'ensure-shortage'` that creates the shortage without reserving.)

- [ ] **Step 3:** Browser verify: on a shortage line that was never reserved, "Raise PR" now creates a PR (no "reserve first" error). Screenshot.
- [ ] **Step 4: Commit** → `git commit -m "feat(planning): self-sufficient Raise PR + planner name on reservation"`

### Task 5.5: Complete the PR auto-fill (req-8 — the 3 missing fields)

**Files:**
- Modify: `prisma/schema.prisma` — add to `PurchaseRequisition`: `requiredSheets Int?`, `customerPoNumber String?`, `productName String?`. Add to the reservation movement model: `reservedByName String?`.
- Migration: `npx prisma migrate dev --name pr_planning_fields` (needs `DIRECT_URL`; per project memory).
- Modify: `src/lib/material-readiness-service.ts:466-490` (`createPurchaseRequestFromShortage`): populate the three new columns.
- Test: `src/lib/material-readiness-service.test.ts` (mock tx; assert the create payload includes the new fields).

- [ ] **Step 1: Failing test** — mock `tx.purchaseRequisition.create` and assert it's called with `customerPoNumber`, `productName`, `requiredSheets`. (Stub the `poLineItem.findUnique` to return `{ cartonName, po: { poNumber, deliveryRequiredBy } }`, and the shortage to carry the required sheets — extend the shortage select to include a stored `requiredSheets` if available, else compute from `remainingQty + allocatedQty`.)

- [ ] **Step 2: Run red** → FAIL.
- [ ] **Step 3: Implement** — in the `create({ data: {...} })` (line 466-490) add:

```ts
        requiredSheets: Number(shortage.shortageQty ?? 0) + Number(shortage.allocatedQty ?? 0) || undefined,
        customerPoNumber: poRef || undefined,
        productName: cartonRef || undefined,
```
(`poRef` and `cartonRef` already computed at lines 463-464. `requiredSheets` = full requirement = allocated + shortage; if the shortage row doesn't carry `allocatedQty`, add it to the select at line 386-399.)

- [ ] **Step 4: Run green** → PASS. Run `npm test -- src/lib/material-readiness-service.test.ts`.
- [ ] **Step 5: Commit** → `git commit -m "feat(planning): populate PR required-sheets, customer PO and product name (req-8)"`

> Surface the new fields wherever PRs are listed (purchase-requisitions page) only if trivial; otherwise note as a follow-up. Do NOT redesign that page.

---

# PHASE 6 — Gang compatibility, release guard, downstream flow (req-11, req-10, req-12)

### Task 6.1: Extend the gang/make-processing compatibility gate

**Files:**
- Modify: `src/app/api/planning/po-lines/make-processing/route.ts:22-57`.
- Test: route test if the project supports it; else extract the comparison into a pure helper `lib/gang-compat.ts` + unit-test that.

Today only `coatingType` + `gsm` are checked (409 hard block). Req-11 wants board type, print side, sheet size, delivery timeline, machine/press compared too, with a **non-silent warning** (not always a hard fail).

- [ ] **Step 1:** Create `src/lib/gang-compat.ts` with a pure `checkGangCompat(lines)` returning `{ ok: boolean; conflicts: Array<{ field: string; values: string[] }>; warnings: Array<{ field: string; values: string[] }> }`. Hard conflicts: board type, GSM, coating, print side (incompatible to print together). Warnings: sheet size, delivery timeline (>X days apart), press. Unit-test it (red→green).
- [ ] **Step 2:** In the route, `select` the extra fields (`paperType`, `specOverrides` for printSide + sheetSize + machineId, `po: { deliveryRequiredBy }`), call `checkGangCompat`, return `409` only on hard `conflicts`, and include `warnings` in a `200` response payload so the UI can show them.
- [ ] **Step 3:** Surface warnings in the planning page toast / a small inline notice (reuse existing toast; no new UI system).
- [ ] **Step 4: Commit** → `git commit -m "feat(planning): extend gang compatibility checks with warnings (req-11)"`

### Task 6.2: Block "Released" in Batch Decision when shortage open without PR (req-10)

**Files:**
- Modify: `src/components/planning/engine/types.ts` (`batchDecision.releaseGuard?: { canRelease: boolean; reason: string | null }`).
- Modify: `src/components/planning/engine/buildEngineLine.ts` (set `releaseGuard` via `computeReleaseGuard`).
- Modify: `src/components/planning/engine/SectionBatchDecision.tsx` (disable the "Released" pill when `!releaseGuard.canRelease`; show reason).

- [ ] **Step 1: Failing test** in `SectionBatchDecision.test.tsx`: with `batchDecision.releaseGuard = { canRelease: false, reason: '...' }`, assert the "Released" pill button is `disabled`.
- [ ] **Step 2: Run red** → FAIL.
- [ ] **Step 3: Implement** — adapter: `releaseGuard: computeReleaseGuard({ shortageSheets, prStatus })`. Section: the `SegmentedPill` for status needs per-option disabling. Since `SegmentedPill` disables all-or-nothing, special-case: when rendering status, if `!releaseGuard.canRelease`, intercept `persistStatus` to reject `'Released'` and show the reason text, OR pass a `disabledOptions` set to a small extension of `SegmentedPill`. Simplest: in `persistStatus`, `if (next === 'Released' && bd?.releaseGuard && !bd.releaseGuard.canRelease) { toast/inline reason; return }`. Also render the reason under the pills.
- [ ] **Step 4: Run green** → PASS.
- [ ] **Step 5: Commit** → `git commit -m "feat(planning): block Release status when shortage open without PR (req-10)"`

### Task 6.3: Wire Save & Lock → downstream (Artwork Queue / Job Card) (req-12)

**Files:**
- Modify: `src/components/planning/PlanningJobDetailDrawer.tsx` (`handleEngineLock`).
- Use existing endpoints: `make-processing` (→ AW queue, `planningStatus='design_ready'`) and the **orphaned** `generate-job-card` route.

Today lock only saves spec/remarks. Req-12 wants the lock to propagate. Decision: on lock, persist the decision **and** push to AW queue (`make-processing`). Job-card generation should remain a deliberate downstream step (it sets tooling custody, stages, etc.) — wire it as an explicit "Generate job card" action rather than auto-firing, but make it reachable (it's currently orphaned).

- [ ] **Step 1:** `handleEngineLock`: after `onSave(line.id)`, if `readinessFive.allReady`, POST `/api/planning/po-lines/make-processing` with `{ lineIds: [line.id] }` (reuse the page's `makeProcessingForIds` by passing it down, or call the endpoint directly). Persist `lockedAt`/`lockedByName` into `planningCore` so the adapter shows the locked state.
- [ ] **Step 2:** Add a "Generate job card" button (only visible once locked + AW-approved) that POSTs to `/api/planning/po-lines/${line.id}/generate-job-card`. This finally wires the orphaned route. Reuse existing button styling.
- [ ] **Step 3:** Browser verify the full chain: select board → reserve → lock → line moves to `design_ready` (AW queue) → Generate job card creates the JC (check `/api/job-cards`). Screenshots of each transition.
- [ ] **Step 4: Commit** → `git commit -m "feat(planning): lock pushes to AW queue + wires job-card generation (req-12)"`

---

# PHASE 7 — Dead-code cleanup (req-13)

### Task 7.1: Delete the `{false && …}` legacy drawer body

**Files:**
- Modify: `src/components/planning/PlanningJobDetailDrawer.tsx:1503-2359` (the dead block).

By now every still-needed control (warehouse popup, reserved/free views, reserve/unreserve/adjust, raise PR) lives in the live engine. The legacy body is fully redundant.

- [ ] **Step 1:** Confirm nothing live references symbols defined *only* inside the dead block. Run `npx tsc --noEmit` after deletion to catch any reference.
- [ ] **Step 2:** Delete lines 1503-2359 (the `{false && ( … )}` wrapper and its contents). Also remove now-unused handlers/state that were exclusive to it (tsc + eslint `no-unused-vars` will flag them) — but keep the reserve-confirm / reservation-control **modals** if the live engine now triggers them.
- [ ] **Step 3:** Run `npx tsc --noEmit` (clean), `npm run lint` (no new unused), `npm test` (≥ baseline).
- [ ] **Step 4:** Browser smoke test the whole drawer once more. Screenshot.
- [ ] **Step 5: Commit** → `git commit -m "refactor(planning): remove dead legacy drawer body (req-13)"`

### Task 7.2: Final full-suite + type + lint gate

- [ ] **Step 1:** `npm test` → pass count ≥ Phase-0 baseline + all new tests; the only failures are the pre-existing ones recorded in Task 0.
- [ ] **Step 2:** `npx tsc --noEmit` → clean.
- [ ] **Step 3:** `npm run lint` → clean (or no new findings).
- [ ] **Step 4:** Browser regression pass over: Planning grid → drawer → all 5 sections → reserve/unreserve → raise PR → lock → AW → job card. Capture a short screenshot set.
- [ ] **Step 5: Commit** any final fixups → `git commit -m "chore(planning): final type/lint/test gate for 13-area build"`

---

## Self-Review (run after the plan, against the 13 requirements)

| Req | Covered by | 
|---|---|
| 1 Product identity header | Task 3.1 (SectionProductRequirement: PO, product, AW code, customer, board, GSM, carton size, qty, status) |
| 2 Separate sheet fields | Task 2.1 (meta), 2.4 (Length/Width/Unit/Cut-type/Child-size UI) |
| 3 Auto-calc (incl. make-ready, yield, balance, shortage) | Task 2.2 (resolver make-ready bucket), 2.3 (thread), 2.5 (expected-yield + balance tiles); base/total/shortage already existed |
| 4 Smart Match ranked engine | Task 4.1 (score%/reason/rank labels), 4.2 (gang-candidates), 4.3 (composite scorer #1–#5 + sub-scores), 4.4 (wire to UI) |
| 5 Warehouse popup | Task 5.1 (popup, 5 views), 5.2 (open from engine) |
| 6 Warehouse connection on reserve (incl. planner name) | reserve already updates stock; Task 5.4 adds planner name; 5.5 schema |
| 7 Reserve/Unreserve/partial/change board/raise PR | Reserve+change-board already live; Task 5.3 (unreserve/adjust), 5.4 (raise PR) |
| 8 PR trigger + 9-field auto-fill | Task 5.5 (adds Required Sheets, Customer PO, Product Name; other 6 already set), 5.4 (self-sufficient trigger) |
| 9 UI sections 1–5 | Task 3.1, 3.2, 3.3 (order); sections 2/4/5 already exist |
| 10 Validation rules | Task 1.1 (readinessFive gate: UPS/sheet/board+GSM/allocation), 1.3 (Save & Lock enforces), 6.2 (release guard) |
| 11 Gang compatibility | Task 6.1 (board/print-side/sheet/delivery/press checks + warnings) |
| 12 Data flow lock→AW→Job Card | Task 6.3 (lock → make-processing → generate-job-card wiring) |
| 13 Don't remove modules / clean dead code | Phases are additive; Task 7.1 removes only the proven-dead `{false &&}` block |

**Placeholder scan:** core logic (validation, adapter, make-ready, scorer, PR fields) ships with complete code + tests. UI tasks give exact JSX + anchor lines. Two spots intentionally say "confirm the endpoint/shape" (operator-master response in 1.4; reservation-control path in 5.3; GlobalPopoutModal in 5.1) — these require a one-line grep at execution time because the exact response/prop shape wasn't captured in research; each task names the grep to run. Resolve those before coding the task.

**Type consistency:** `PlanningEngineLine`, `PlanningEngineReadiness`, `PlanningEngineBoardOption`, and the `smartMatch.suggestions` shape are used identically across adapter, scorer and sections (all import from `engine/types.ts`). `computeReadinessFive`/`computeReleaseGuard` signatures match between `planningValidation.ts` and `buildEngineLine.ts`. `mergePlanningMetaSheetSpec` is defined in Task 2.1 and consumed in Task 2.4 with the same param names.

**Known behavioral note for the user:** Make-ready defaults to **0** (Task 2.2) so no existing reservation math changes until a planner sets a make-ready value — deliberately conservative per the "apply incrementally and safely" instruction. If you want make-ready to auto-compute a non-zero default (e.g. from colour count), that's a one-line change in `resolveRequirementFromLine` we can make once you confirm you want every existing line's required-sheets to increase.
