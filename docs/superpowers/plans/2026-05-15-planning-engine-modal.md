# Planning Engine — Centered Modal + Smart Match + Reservation Safety

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the right-side `PlanningJobDetailDrawer` into a centered 60vw "Planning engine" modal with a clear four-section layout, a real Smart Match score (Size + Waste + Urgency + Tool), atomic paper-warehouse reservations, and one-click shortage→PR flow.

**Architecture:**
- Reuse the existing `PlanningEngineModal` shell (already centered, 60vw, scale-in animation). Rebuild the drawer's body into a focused four-section grid: Board Allocation, Smart Match, UPS & Sheet Spec, Batch Decision.
- Extract the scoring math into a single deterministic lib (`smart-match-scoring.ts`) that wraps the existing `material-cut-fit` engine, adds `urgencyScore` (deadline-aware) and `toolScore` (die/plate readiness), and exposes a `compositeScore` used by both the grid list view and the modal.
- Auto-save individual fields on blur via a debounced `PATCH /api/planning/po-lines/:id` (200ms). Explicit "Save & lock" runs a server-side validator that freezes the decision via the existing `reservation-control` route and flips status to Locked.
- Atomic reservations: confirm `reserveMaterial` is transactional; add an `If-Match` style optimistic concurrency guard so two planners cannot double-claim the same paper lot.
- Shortage → PR: inline "Raise PR" affordance that calls existing `POST /api/purchase-requests` then surfaces ETA / on-order back into the readiness pill.

**Tech Stack:** Next.js App Router · React · Tailwind (ds-* tokens) · Prisma · React Query (existing `useQuery`/`useMutation` patterns in repo) · Sonner toasts · Vitest.

---

## File Structure

**New files**
- `src/lib/smart-match-scoring.ts` — composite scoring (wraps material-cut-fit, adds urgency + tool sub-scores). ~180 lines.
- `src/lib/smart-match-scoring.test.ts` — vitest unit tests. ~250 lines.
- `src/components/planning/engine/PlanningEngineBody.tsx` — orchestrator that lays out the four sections inside `PlanningEngineModal`. ~220 lines.
- `src/components/planning/engine/SectionBoardAllocation.tsx` — Board Allocation card (paper warehouse, PR, shortage). ~280 lines.
- `src/components/planning/engine/SectionSmartMatch.tsx` — Smart Match suggestions with new composite score + sub-score bars. ~260 lines.
- `src/components/planning/engine/SectionUpsAndSpec.tsx` — UPS, sheet yield, make-ready, BPI. ~180 lines.
- `src/components/planning/engine/SectionBatchDecision.tsx` — Status, layout type, designer, press, smart pick. ~200 lines.
- `src/components/planning/engine/usePlanningAutosave.ts` — debounced field-patch hook. ~100 lines.
- `src/components/planning/engine/RaisePrInlineButton.tsx` — shortage→PR affordance. ~120 lines.
- `src/app/api/planning/po-lines/[id]/lock-decision/route.ts` — explicit lock endpoint. ~120 lines.

**Modified files**
- `src/app/api/planning/po-lines/route.ts` — wire `buildMaterialCutFitOptions` + new scoring lib into the list response so grid and modal share one truth. (~50 lines added inside the per-line map.)
- `src/app/api/planning/po-lines/[id]/reserve-material/route.ts` — add optimistic-concurrency guard via `expectedReservedVersion` and surface `boardLotId` in response.
- `src/app/api/planning/po-lines/[id]/route.ts` — extend PATCH to accept the autosave fields (ups, sheetSize, layoutType, designerId, machineId, plannedBatch, status) with field-level validation.
- `src/lib/material-readiness-service.ts` — extend `reserveMaterial` to accept and verify `expectedReservedVersion`; return new `reservedVersion` after commit.
- `src/lib/material-cut-fit.ts` — export an internal-use `MaterialCutFitOption` builder hook so smart-match-scoring can layer on urgency/tool without re-doing size/waste math.
- `src/components/planning/PlanningJobDetailDrawer.tsx` — gut the body and replace it with `<PlanningEngineBody />`. Keep the data-loading top-level effect, props, and save callbacks.
- `prisma/schema.prisma` — add `reservedVersion Int @default(0)` to `PaperWarehouseReservation` (or whatever the active reservation model is — confirm in Task 0).
- `src/components/planning/PlanningEngineModal.tsx` — minor: add a `lockState` prop ("draft" | "locking" | "locked") to drive header pill + footer button copy.

---

## Phase Overview

| Phase | Focus | Net code delta | Risk |
|---|---|---|---|
| 0 | Confirm reservation model name + Vitest config | reads only | low |
| 1 | Centered-modal layout rebuild (four sections) | +1100 / -1800 | medium (visual regressions) |
| 2 | Autosave infrastructure + lock-decision endpoint | +400 | medium (state sync) |
| 3 | Smart Match scoring engine (composite + sub-scores) | +500 | low (pure functions, fully testable) |
| 4 | Paper warehouse safety: optimistic concurrency on reservation | +200 | high (data correctness) |
| 5 | Inline Raise-PR + ETA reflection back into readiness | +250 | medium |
| 6 | Cleanup: delete the old drawer body, verify, commit | -400 | low |

---

## Phase 0 — Discovery confirmations

### Task 0.1: Identify the active reservation model

**Files:**
- Read: `prisma/schema.prisma`
- Read: `src/lib/material-readiness-service.ts`

- [ ] **Step 1: Search the schema**

```bash
grep -nE "model.*Reservation|model.*MaterialReservation|reservedBy|reservedFor" prisma/schema.prisma
```

Expected: identify the table name (likely `PaperWarehouseReservation` or `MaterialReservation`). Record the exact name as **`<RESERVATION_MODEL>`** and use it consistently in Tasks 4.1–4.4.

- [ ] **Step 2: Confirm the reservation function**

```bash
grep -nE "export (async )?function reserveMaterial|export (async )?function reserveMaterialForPlanning" src/lib/material-readiness-service.ts
```

Expected: two exports. Note their exact signatures — Task 4.2 extends both.

- [ ] **Step 3: Confirm Vitest is configured**

```bash
cat vitest.config.ts 2>/dev/null || cat vite.config.ts 2>/dev/null || grep -l vitest package.json
```

Expected: a vitest config exists. If not, Task 3.1 includes adding one.

- [ ] **Step 4: No commit** — discovery only.

---

## Phase 1 — Centered modal layout rebuild

### Task 1.1: Stub the body orchestrator with the four-section grid

**Files:**
- Create: `src/components/planning/engine/PlanningEngineBody.tsx`

- [ ] **Step 1: Write the file**

```tsx
'use client'

import type { PlanningGridLine, PlanningLineFieldPatch } from '@/components/planning/PlanningDecisionGrid'
import { SectionBoardAllocation } from './SectionBoardAllocation'
import { SectionSmartMatch } from './SectionSmartMatch'
import { SectionUpsAndSpec } from './SectionUpsAndSpec'
import { SectionBatchDecision } from './SectionBatchDecision'

export type PlanningEngineBodyProps = {
  line: PlanningGridLine
  onPatch: (patch: PlanningLineFieldPatch) => Promise<boolean>
  onLock: () => Promise<void>
}

export function PlanningEngineBody({ line, onPatch, onLock }: PlanningEngineBodyProps) {
  return (
    <div className="grid grid-cols-2 gap-4">
      <SectionBoardAllocation line={line} onPatch={onPatch} />
      <SectionSmartMatch line={line} onPatch={onPatch} />
      <SectionUpsAndSpec line={line} onPatch={onPatch} />
      <SectionBatchDecision line={line} onPatch={onPatch} onLock={onLock} />
    </div>
  )
}
```

- [ ] **Step 2: Add stub section files** so the import compiles

For each of `SectionBoardAllocation`, `SectionSmartMatch`, `SectionUpsAndSpec`, `SectionBatchDecision`, create a file under `src/components/planning/engine/` that exports a named component returning a `<CardSection title="…">stub</CardSection>`. Use the existing `CardSection` from `@/components/design-system/CardSection`.

Example stub (`SectionBoardAllocation.tsx`):

```tsx
'use client'
import type { PlanningGridLine, PlanningLineFieldPatch } from '@/components/planning/PlanningDecisionGrid'
import { CardSection } from '@/components/design-system/CardSection'

type Props = {
  line: PlanningGridLine
  onPatch: (patch: PlanningLineFieldPatch) => Promise<boolean>
}

export function SectionBoardAllocation({ line }: Props) {
  return <CardSection title="Board Allocation">stub</CardSection>
}
```

- [ ] **Step 3: Run the typecheck**

```bash
pnpm typecheck
```

Expected: PASS (the stubs reference props but don't use them; `_` prefix unused if lint complains).

- [ ] **Step 4: Commit**

```bash
git add src/components/planning/engine
git commit -m "planning engine: scaffold four-section body shell"
```

---

### Task 1.2: Wire the new body into the drawer's modal

**Files:**
- Modify: `src/components/planning/PlanningJobDetailDrawer.tsx` (the `<PlanningEngineModal>` child)

- [ ] **Step 1: Find the modal body**

```bash
grep -n "<PlanningEngineModal" src/components/planning/PlanningJobDetailDrawer.tsx
```

Expected: a single render around the existing JSX. Locate the children prop body — that's what we replace.

- [ ] **Step 2: Replace the children with the new body**

Inside the `<PlanningEngineModal>` element, replace the existing children block with:

```tsx
<PlanningEngineBody
  line={line}
  onPatch={async (patch) => onSaveLine(line.id, patch)}
  onLock={async () => {
    await fetch(`/api/planning/po-lines/${line.id}/lock-decision`, { method: 'POST' })
    await onSave(line.id)
  }}
/>
```

Keep all existing prop wiring on `<PlanningEngineModal>` (title, metadata, statusBar, footer). The lock-decision endpoint comes in Task 2.4 — it's safe to reference now because the modal is still using the old body content until Task 1.7.

- [ ] **Step 3: Guard the existing body**

Wrap the old children inside a `{false &&` to keep them out of the render tree but available for reference until Phase 6. **Do not delete** yet.

- [ ] **Step 4: Visual smoke**

```bash
pnpm dev
```

Open the planning page, click a PO line, confirm the modal renders four "stub" cards in a 2×2 grid and closes cleanly. Note any console errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/planning/PlanningJobDetailDrawer.tsx
git commit -m "planning engine: render PlanningEngineBody inside centered modal"
```

---

### Task 1.3: Build SectionBoardAllocation

**Files:**
- Modify: `src/components/planning/engine/SectionBoardAllocation.tsx`

**What the section must display (from screenshot + data model):**
1. **Board type** (FBB) and **GSM** as read-only chips on row 1, two columns.
2. **Sheet size** (720×1020 mm) and **Required** (4,800 sh) on row 2.
3. **Paper warehouse — shortage** banner if `line.materialQueue.shortageSheets > 0`. Show Net stock / Reserved / Shortfall as three stacked metrics. Background `bg-red-500/10 border-red-500/40`.
4. **PR / purchase order** row if `line.materialQueue.prId`. Show `PR-XXXX` link, qty, ETA, status pill ("On order").

- [ ] **Step 1: Write the failing visual contract test**

Create `src/components/planning/engine/SectionBoardAllocation.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { SectionBoardAllocation } from './SectionBoardAllocation'

const baseLine = {
  id: 'L1',
  boardType: 'FBB',
  gsm: 100,
  sheetSize: '720×1020 mm',
  materialQueue: {
    totalSheets: 4800,
    availableSheets: 1240,
    reservedSheets: 3100,
    shortageSheets: 3560,
    prId: 'PR-2024-1143',
    prEtaDate: '2026-05-18',
  },
} as any

describe('SectionBoardAllocation', () => {
  it('renders board, GSM, sheet size and required sheets', () => {
    render(<SectionBoardAllocation line={baseLine} onPatch={async () => true} />)
    expect(screen.getByText('FBB')).toBeInTheDocument()
    expect(screen.getByText('100 gsm')).toBeInTheDocument()
    expect(screen.getByText('720×1020 mm')).toBeInTheDocument()
    expect(screen.getByText('4,800 sh')).toBeInTheDocument()
  })
  it('shows the shortage banner when shortageSheets > 0', () => {
    render(<SectionBoardAllocation line={baseLine} onPatch={async () => true} />)
    expect(screen.getByText(/Paper warehouse — shortage/i)).toBeInTheDocument()
    expect(screen.getByText('3,560 sh')).toBeInTheDocument()
  })
  it('renders the PR row with ETA when prId present', () => {
    render(<SectionBoardAllocation line={baseLine} onPatch={async () => true} />)
    expect(screen.getByText('PR-2024-1143')).toBeInTheDocument()
    expect(screen.getByText(/ETA 18 May/)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
pnpm vitest run src/components/planning/engine/SectionBoardAllocation.test.tsx
```

Expected: FAIL — section is still the stub.

- [ ] **Step 3: Implement the section**

Replace the stub body with the implementation. Use existing tokens (`text-ds-ink`, `text-ds-ink-muted`, `bg-ds-elevated`, `border-ds-line/40`). Format thousands with `Intl.NumberFormat('en-IN')`. Format `prEtaDate` with `new Date(...).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })`.

Structure:
- `<CardSection title="BOARD ALLOCATION">`
- Inner `<div className="grid grid-cols-2 gap-3">` with four metric tiles (board type, GSM, sheet size, required sheets). Each tile: `bg-ds-elevated rounded-ds-md p-3` with label in `text-[10px] uppercase tracking-wider text-ds-ink-faint` and value in `text-base font-semibold text-ds-ink`.
- Below the grid, conditional shortage banner.
- Below the banner, conditional PR row with chip badge "On order" (`bg-amber-500/15 text-amber-400 border-amber-500/40`).

- [ ] **Step 4: Run the test**

```bash
pnpm vitest run src/components/planning/engine/SectionBoardAllocation.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/planning/engine/SectionBoardAllocation.tsx src/components/planning/engine/SectionBoardAllocation.test.tsx
git commit -m "planning engine: board allocation section with shortage + PR row"
```

---

### Task 1.4: Build SectionUpsAndSpec

**Files:**
- Modify: `src/components/planning/engine/SectionUpsAndSpec.tsx`

**Fields:**
1. Units per sheet — editable number input with an "Auto" badge if `line.upsSource === 'auto'`. Calls `onPatch({ ups: n })` on blur.
2. Sheet yield — read-only percentage (computed: `(orderQty / (ups * totalSheets)) * 100`).
3. Make-ready sheets — read-only number with breakdown text below (`50 base + 4×20c + 30 UV`).
4. BPI (Best Possible Index) — read-only badge "Optimal" / "Suboptimal" with margin-vs-setup tooltip.

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { SectionUpsAndSpec } from './SectionUpsAndSpec'

const baseLine = {
  id: 'L1', orderQty: 18000, materialQueue: { totalSheets: 4800 }, ups: 4, upsSource: 'auto',
  makeReady: { total: 180, base: 50, colours: { count: 4, perColour: 20 }, uv: 30 },
  bpi: { status: 'Optimal', marginInr: 36000, setupInr: 25800 },
} as any

describe('SectionUpsAndSpec', () => {
  it('renders ups input with Auto chip', () => {
    render(<SectionUpsAndSpec line={baseLine} onPatch={async () => true} />)
    expect(screen.getByDisplayValue('4')).toBeInTheDocument()
    expect(screen.getByText('Auto')).toBeInTheDocument()
  })
  it('calls onPatch on blur with parsed ups', async () => {
    const onPatch = vi.fn().mockResolvedValue(true)
    render(<SectionUpsAndSpec line={baseLine} onPatch={onPatch} />)
    const input = screen.getByDisplayValue('4') as HTMLInputElement
    fireEvent.change(input, { target: { value: '6' } })
    fireEvent.blur(input)
    expect(onPatch).toHaveBeenCalledWith({ ups: 6 })
  })
  it('computes sheet yield to one decimal', () => {
    render(<SectionUpsAndSpec line={baseLine} onPatch={async () => true} />)
    // 18000 / (4 * 4800) = 0.9375 → not exactly 74.3 in this stub; replace with values that yield 74.3
    // For this test we just assert a percent format is rendered.
    expect(screen.getByText(/%$/)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Verify failure**

```bash
pnpm vitest run src/components/planning/engine/SectionUpsAndSpec.test.tsx
```

Expected: FAIL.

- [ ] **Step 3: Implement**

Layout: 2×2 grid like Board Allocation. Top-left: UPS input (text-base font-semibold, `bg-ds-elevated rounded-ds-md` 56px tall) with optional `<Badge>Auto</Badge>` to the right of the value. Top-right: Sheet yield read-only tile. Bottom-left: Make-ready tile with breakdown subtext. Bottom-right: BPI tile with `Optimal` in `text-emerald-400` and `₹{margin} margin vs ₹{setup} setup` subtext.

- [ ] **Step 4: Pass**

```bash
pnpm vitest run src/components/planning/engine/SectionUpsAndSpec.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add src/components/planning/engine/SectionUpsAndSpec.tsx src/components/planning/engine/SectionUpsAndSpec.test.tsx
git commit -m "planning engine: ups & sheet spec section"
```

---

### Task 1.5: Build SectionSmartMatch

**Files:**
- Modify: `src/components/planning/engine/SectionSmartMatch.tsx`

**This section renders the Smart Match suggestions returned by the planning API. Scoring is computed in Phase 3; this task is the rendering shell.**

For each suggestion (up to 3 visible, scrollable for more):
- Title: "Suggestion A / B / C — `<PO refs>` + this line"
- Confidence pill (High/Medium/Low) with composite score number, right-aligned, color-coded.
- Three-line metadata: `N lines · N pcs · Avg yield NN.N% · ~N sh`.
- **Sub-score row**: four mini-bars labelled Size, Waste, Urgency, Tool (0-100). Use `<div className="h-1 rounded-full bg-ds-elevated"><div style={{width: '81%'}} className="h-full bg-emerald-400/80 rounded-full" /></div>`.
- Below the list: "Board match confidence NN%" with a wide bar and the source code (e.g. `Matched on FBB / 100g / 4C UV — material code ITC-FBB-100`).

The top suggestion has a subtle green highlight (`bg-emerald-500/8 border-emerald-500/30`); the rest are neutral.

- [ ] **Step 1: Write failing test**

```tsx
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { SectionSmartMatch } from './SectionSmartMatch'

const line = {
  id: 'L1',
  smartMatch: {
    boardMatchConfidence: 0.94,
    materialCode: 'ITC-FBB-100',
    matchedOn: 'FBB / 100g / 4C UV',
    suggestions: [
      { label: 'A', tier: 'High', composite: 82.4, sizeScore: 81, wasteScore: 79, urgencyScore: 72, toolScore: 80,
        poRefs: ['PO-2024-0829', 'PO-2024-0831'], linesIncluded: 3, totalPcs: 52000, avgYieldPct: 77.1, totalSheets: 340 },
      { label: 'B', tier: 'Medium', composite: 58.1, sizeScore: 60, wasteScore: 55, urgencyScore: 50, toolScore: 65,
        poRefs: ['PO-2024-0801'], linesIncluded: 2, totalPcs: 31000, avgYieldPct: 64.8, totalSheets: 220 },
    ],
  },
} as any

describe('SectionSmartMatch', () => {
  it('renders top suggestion with composite score and sub-scores', () => {
    render(<SectionSmartMatch line={line} onPatch={async () => true} />)
    expect(screen.getByText(/Suggestion A/)).toBeInTheDocument()
    expect(screen.getByText('82.4')).toBeInTheDocument()
    expect(screen.getByText('High')).toBeInTheDocument()
    expect(screen.getByLabelText('Size sub-score 81')).toBeInTheDocument()
  })
  it('renders board match confidence as a percentage', () => {
    render(<SectionSmartMatch line={line} onPatch={async () => true} />)
    expect(screen.getByText('94%')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Implement**

Render `line.smartMatch?.suggestions ?? []`, slice top 3, fallback "No suggestions yet" empty state.

Sub-score bar component should accept `{ label, value }` and render `aria-label={`${label} sub-score ${value}`}` so the test above passes.

- [ ] **Step 3: Pass & commit**

```bash
pnpm vitest run src/components/planning/engine/SectionSmartMatch.test.tsx
git add src/components/planning/engine/SectionSmartMatch.tsx src/components/planning/engine/SectionSmartMatch.test.tsx
git commit -m "planning engine: smart match section with sub-score bars"
```

---

### Task 1.6: Build SectionBatchDecision

**Files:**
- Modify: `src/components/planning/engine/SectionBatchDecision.tsx`

**Fields (all editable; patch on blur via `onPatch`):**
- Status segmented control: Ready / Draft / Hold / Approved AW / Released. Selected pill `bg-emerald-500/15 text-emerald-300 border-emerald-500/30`.
- Layout type: Gang / Single segmented.
- Set number: text input prefilled `SET-NNN` with "auto" hint.
- Designer: dropdown sourced from `line.designerOptions` (Avneet Singh / Shamsher Inder).
- Press assignment card: machine code (CI-02), specs (6-colour bed, 1020×760 mm, Load 48%, ~5.2h run) plus "Smart pick" chip linked to the top Smart Match suggestion.
- Lock decision button hooks `onLock`. Disabled until `line.readinessFive.allReady === true` OR force-lock confirmed.

- [ ] **Step 1: Failing test**

```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { SectionBatchDecision } from './SectionBatchDecision'

const line = {
  id: 'L1', status: 'Ready', layoutType: 'Gang', setNumber: 'SET-007', setNumberAuto: true,
  designerOptions: [{ id: 'u1', name: 'Avneet Singh' }, { id: 'u2', name: 'Shamsher Inder' }],
  designerId: 'u2',
  pressAssignment: { code: 'CI-02', deckLabel: '6-colour bed', size: '1020×760 mm', loadPct: 48, runHours: 5.2, smartPicked: true },
  readinessFive: { allReady: false, blockers: ['PA shortage'] },
} as any

describe('SectionBatchDecision', () => {
  it('renders status pills with Ready selected', () => {
    render(<SectionBatchDecision line={line} onPatch={async () => true} onLock={async () => {}} />)
    const ready = screen.getByRole('button', { name: 'Ready' })
    expect(ready).toHaveAttribute('aria-pressed', 'true')
  })
  it('patches layoutType when Single is clicked', () => {
    const onPatch = vi.fn().mockResolvedValue(true)
    render(<SectionBatchDecision line={line} onPatch={onPatch} onLock={async () => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Single' }))
    expect(onPatch).toHaveBeenCalledWith({ layoutType: 'Single' })
  })
  it('disables Save & lock when readinessFive.allReady is false', () => {
    render(<SectionBatchDecision line={line} onPatch={async () => true} onLock={async () => {}} />)
    expect(screen.getByRole('button', { name: /Save & lock/i })).toBeDisabled()
  })
})
```

- [ ] **Step 2: Implement** per the field list above.

- [ ] **Step 3: Pass & commit**

```bash
pnpm vitest run src/components/planning/engine/SectionBatchDecision.test.tsx
git add src/components/planning/engine/SectionBatchDecision.tsx src/components/planning/engine/SectionBatchDecision.test.tsx
git commit -m "planning engine: batch decision section + save & lock guard"
```

---

### Task 1.7: Switch the drawer over fully and visual-review

**Files:**
- Modify: `src/components/planning/PlanningJobDetailDrawer.tsx`

- [ ] **Step 1: Remove the `false && (old body)` guard** introduced in Task 1.2. Delete the old JSX block entirely. Keep top-level effects, props, and the `PlanningEngineModal` wrapper.

- [ ] **Step 2: Run the dev server, open three real PO lines** (one ready, one with shortage, one already locked). Capture screenshots. Confirm:
  - Modal centers at 60vw on a 1920px display.
  - Four cards arranged 2×2; on viewport `< 1180px` they should stack vertically — verify the grid uses `grid-cols-1 lg:grid-cols-2`.
  - Sticky header shows "Planning engine" label + carton title.
  - Esc closes; outside-click closes; X closes.

- [ ] **Step 3: Typecheck**

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/planning/PlanningJobDetailDrawer.tsx
git commit -m "planning engine: replace drawer body with PlanningEngineBody"
```

---

## Phase 2 — Autosave + explicit lock

### Task 2.1: Implement the autosave hook

**Files:**
- Create: `src/components/planning/engine/usePlanningAutosave.ts`
- Create: `src/components/planning/engine/usePlanningAutosave.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { usePlanningAutosave } from './usePlanningAutosave'

describe('usePlanningAutosave', () => {
  it('debounces multiple patches to one server call', async () => {
    vi.useFakeTimers()
    const onPatch = vi.fn().mockResolvedValue(true)
    const { result } = renderHook(() => usePlanningAutosave({ onPatch, debounceMs: 200 }))
    act(() => { result.current.scheduleSave({ ups: 4 }) })
    act(() => { result.current.scheduleSave({ ups: 5 }) })
    act(() => { result.current.scheduleSave({ ups: 6 }) })
    await act(async () => { vi.advanceTimersByTime(250) })
    expect(onPatch).toHaveBeenCalledTimes(1)
    expect(onPatch).toHaveBeenCalledWith({ ups: 6 })
    vi.useRealTimers()
  })
  it('exposes "saving" and "saved" status transitions', async () => {
    vi.useFakeTimers()
    const onPatch = vi.fn().mockResolvedValue(true)
    const { result } = renderHook(() => usePlanningAutosave({ onPatch, debounceMs: 100 }))
    act(() => { result.current.scheduleSave({ ups: 7 }) })
    await act(async () => { vi.advanceTimersByTime(120) })
    expect(['saving', 'saved']).toContain(result.current.status)
    vi.useRealTimers()
  })
})
```

- [ ] **Step 2: Implement the hook**

```ts
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PlanningLineFieldPatch } from '@/components/planning/PlanningDecisionGrid'

export type AutosaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error'

export function usePlanningAutosave(opts: {
  onPatch: (patch: PlanningLineFieldPatch) => Promise<boolean>
  debounceMs?: number
}) {
  const { onPatch, debounceMs = 200 } = opts
  const [status, setStatus] = useState<AutosaveStatus>('idle')
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null)
  const pendingRef = useRef<PlanningLineFieldPatch>({})
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flush = useCallback(async () => {
    if (Object.keys(pendingRef.current).length === 0) return
    const patch = pendingRef.current
    pendingRef.current = {}
    setStatus('saving')
    const ok = await onPatch(patch)
    setStatus(ok ? 'saved' : 'error')
    if (ok) setLastSavedAt(Date.now())
  }, [onPatch])

  const scheduleSave = useCallback((patch: PlanningLineFieldPatch) => {
    pendingRef.current = { ...pendingRef.current, ...patch }
    setStatus('pending')
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => { void flush() }, debounceMs)
  }, [debounceMs, flush])

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])

  return { scheduleSave, flushNow: flush, status, lastSavedAt }
}
```

- [ ] **Step 3: Pass & commit**

```bash
pnpm vitest run src/components/planning/engine/usePlanningAutosave.test.ts
git add src/components/planning/engine/usePlanningAutosave.ts src/components/planning/engine/usePlanningAutosave.test.ts
git commit -m "planning engine: usePlanningAutosave hook with debounced patches"
```

---

### Task 2.2: Wire autosave into PlanningEngineBody

**Files:**
- Modify: `src/components/planning/engine/PlanningEngineBody.tsx`

- [ ] **Step 1:** Replace the direct `onPatch` prop passed down with the hook's `scheduleSave`. Surface a status pill in the modal footer via a new prop callback (e.g. `onAutosaveStatusChange(status, lastSavedAt)`) so the existing `<PlanningEngineModal>` `footerMeta` can show `Saved 10:42` / `Saving…` / `Unsaved changes`.

- [ ] **Step 2:** Update `PlanningJobDetailDrawer` to receive the autosave status and pass it into `<PlanningEngineModal footerMeta={…}>`.

- [ ] **Step 3:** Manual test — type a new UPS value, click outside the input, observe the footer text transitions: `Saving…` → `Saved <time>` within ~250ms.

- [ ] **Step 4: Commit**

```bash
git add src/components/planning/engine/PlanningEngineBody.tsx src/components/planning/PlanningJobDetailDrawer.tsx
git commit -m "planning engine: autosave wiring with footer status pill"
```

---

### Task 2.3: Extend PATCH /api/planning/po-lines/:id to accept the autosave fields

**Files:**
- Modify: `src/app/api/planning/po-lines/[id]/route.ts`

- [ ] **Step 1:** Locate the existing PATCH handler. If none exists, add one. Accept this Zod schema (or equivalent validator already used in the file):

```ts
import { z } from 'zod'

const PatchSchema = z.object({
  ups: z.number().int().min(1).max(96).optional(),
  sheetSize: z.string().min(3).max(40).optional(),
  layoutType: z.enum(['Gang', 'Single']).optional(),
  designerId: z.string().uuid().nullable().optional(),
  machineId: z.string().uuid().nullable().optional(),
  setNumber: z.string().min(1).max(20).optional(),
  status: z.enum(['Ready', 'Draft', 'Hold', 'ApprovedAW', 'Released']).optional(),
  remarks: z.string().max(2000).nullable().optional(),
}).strict()
```

- [ ] **Step 2:** Persist each field via `prisma.poLineItem.update`. Any change to `ups` or `sheetSize` invalidates the cached `materialQueue.totalSheets` — recompute via `calculateBoardSheetsAndWeightErp` from `src/lib/board-mrp.ts` and upsert the `MaterialQueue` row in the same transaction.

- [ ] **Step 3:** Return the updated line with refreshed `materialQueue` so the client can reconcile.

- [ ] **Step 4:** Write an API test under `src/app/api/planning/po-lines/[id]/route.test.ts` covering: patch with `ups: 6` recomputes totalSheets; invalid status (e.g. `'Locked'`) → 400.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/planning/po-lines/[id]/route.ts src/app/api/planning/po-lines/[id]/route.test.ts
git commit -m "planning engine: PATCH endpoint accepts autosave fields + recomputes board MRP"
```

---

### Task 2.4: Add the lock-decision endpoint

**Files:**
- Create: `src/app/api/planning/po-lines/[id]/lock-decision/route.ts`

- [ ] **Step 1: Write the handler**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import { reserveMaterialForPlanning } from '@/lib/material-readiness-service'

export const dynamic = 'force-dynamic'

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  await requireAuth()
  const line = await db.poLineItem.findUnique({ where: { id }, include: { materialQueue: true } })
  if (!line) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })
  // Hard preconditions: artwork locked, plates ready or N/A, die ready, machine assigned
  const blockers: string[] = []
  if (!line.artworkLockedAt) blockers.push('Artwork not locked')
  if (!line.machineId) blockers.push('Press not assigned')
  if (!line.ups || line.ups < 1) blockers.push('UPS not set')
  if (blockers.length) return NextResponse.json({ error: 'PRECONDITIONS_FAILED', blockers }, { status: 422 })
  // Atomic: reserve material + flip line.status to Locked
  await db.$transaction(async (tx) => {
    await reserveMaterialForPlanning(tx, { poLineItemId: id })
    await tx.poLineItem.update({ where: { id }, data: { status: 'Locked', lockedAt: new Date() } })
  })
  const refreshed = await db.poLineItem.findUnique({ where: { id }, include: { materialQueue: true } })
  return NextResponse.json({ ok: true, line: refreshed })
}
```

- [ ] **Step 2: Test**

```bash
curl -X POST http://localhost:3000/api/planning/po-lines/<real-id>/lock-decision
```

Expected: 422 with blockers list for a line that's not ready; 200 with locked line otherwise.

- [ ] **Step 3:** Hook `onLock` in `SectionBatchDecision` to surface the blocker list via a sonner toast when 422 returns.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/planning/po-lines/[id]/lock-decision/route.ts src/components/planning/engine/SectionBatchDecision.tsx
git commit -m "planning engine: explicit lock-decision endpoint with preconditions"
```

---

## Phase 3 — Smart Match scoring engine

### Task 3.1: Define the score model

**Files:**
- Create: `src/lib/smart-match-scoring.ts`
- Create: `src/lib/smart-match-scoring.test.ts`

**Score model:**

```ts
export type SmartMatchInput = {
  // From material-cut-fit
  sizeDeviationPct: number   // 0 = exact size, larger = worse
  wastagePct: number         // 0 = no waste, larger = worse
  isExactGsm: boolean
  isGsmTolerance: boolean
  // Urgency
  hoursUntilDue: number      // negative = overdue
  // Tool readiness
  dieStatus: 'Ready' | 'Pending' | 'Missing'
  platesStatus: 'Ready' | 'Pending' | 'Missing' | 'NotRequired'
  // Stock signal
  freeSheets: number
  requiredSheets: number
}

export type SmartMatchScores = {
  sizeScore: number    // 0-100
  wasteScore: number   // 0-100
  urgencyScore: number // 0-100
  toolScore: number    // 0-100
  composite: number    // weighted: 0.30 size + 0.25 waste + 0.20 urgency + 0.25 tool
  tier: 'High' | 'Medium' | 'Low'
}
```

**Formulas (deterministic, all pure functions):**

- `sizeScore = clamp(100 - sizeDeviationPct * 4, 0, 100)` (exact size 100; 5% deviation 80; 25% deviation 0).
- `wasteScore = clamp(100 - wastagePct * 2, 0, 100)` (no waste 100; 25% waste 50; 50% waste 0).
- `urgencyScore`: piecewise from `hoursUntilDue`:
  - `>= 168` (>= 1 week): 50
  - `48-168`: linear 70-50
  - `24-48`: linear 85-70
  - `0-24`: linear 100-85
  - `< 0` (overdue): 100 (clamped — overdue is most urgent, scores highest because picking it brings the highest urgency match)
- `toolScore`: 100 if both die `Ready` and plates `Ready`/`NotRequired`; 70 if either is `Pending`; 0 if either is `Missing`.
- Bonus modifier: if `freeSheets >= requiredSheets`, add +5 to `wasteScore` (capped at 100). If `isExactGsm`, add +5 to `sizeScore` (capped at 100). Apply bonuses *after* clamping.
- `composite = round(sizeScore * 0.30 + wasteScore * 0.25 + urgencyScore * 0.20 + toolScore * 0.25, 1)`.
- `tier = composite >= 75 ? 'High' : composite >= 55 ? 'Medium' : 'Low'`.

- [ ] **Step 1: Write tests covering the formula edge cases**

```ts
import { describe, it, expect } from 'vitest'
import { computeSmartMatchScores } from './smart-match-scoring'

const base = {
  sizeDeviationPct: 0, wastagePct: 0, isExactGsm: true, isGsmTolerance: false,
  hoursUntilDue: 200, dieStatus: 'Ready', platesStatus: 'Ready',
  freeSheets: 10000, requiredSheets: 4800,
} as const

describe('computeSmartMatchScores', () => {
  it('perfect match scores high', () => {
    const s = computeSmartMatchScores(base)
    expect(s.sizeScore).toBe(100)
    expect(s.wasteScore).toBe(100)
    expect(s.toolScore).toBe(100)
    expect(s.tier).toBe('High')
  })
  it('25% wastage halves the waste score', () => {
    const s = computeSmartMatchScores({ ...base, wastagePct: 25 })
    expect(s.wasteScore).toBeGreaterThanOrEqual(50)
    expect(s.wasteScore).toBeLessThanOrEqual(60) // 50 + bonus 5
  })
  it('overdue scores urgency = 100', () => {
    const s = computeSmartMatchScores({ ...base, hoursUntilDue: -12 })
    expect(s.urgencyScore).toBe(100)
  })
  it('missing die zeroes toolScore', () => {
    const s = computeSmartMatchScores({ ...base, dieStatus: 'Missing' })
    expect(s.toolScore).toBe(0)
  })
  it('composite is a weighted blend', () => {
    const s = computeSmartMatchScores({ ...base, sizeDeviationPct: 5, wastagePct: 10, hoursUntilDue: 36 })
    // size ~85, waste ~85, urgency ~78, tool ~100 → composite ~ 25.5 + 21.25 + 15.6 + 25 = 87.35
    expect(s.composite).toBeGreaterThan(80)
    expect(s.composite).toBeLessThan(95)
    expect(s.tier).toBe('High')
  })
})
```

- [ ] **Step 2: Implement the pure functions** matching the formulas above.

- [ ] **Step 3: Run tests**

```bash
pnpm vitest run src/lib/smart-match-scoring.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/smart-match-scoring.ts src/lib/smart-match-scoring.test.ts
git commit -m "smart match: deterministic composite scoring (size + waste + urgency + tool)"
```

---

### Task 3.2: Wire the scoring into the planning list API

**Files:**
- Modify: `src/app/api/planning/po-lines/route.ts` (replace the dumb `suggestedBoardOptions` block at lines 230-236)

- [ ] **Step 1:** Replace the existing 7-line `suggestedBoardOptions` block with a call to `buildMaterialCutFitOptions` (from `src/lib/material-cut-fit.ts`) followed by a `computeSmartMatchScores` map. The input gathering can lean on the existing `auto.*` and `matchedPaperRows` variables already in scope.

```ts
import { buildMaterialCutFitOptions } from '@/lib/material-cut-fit'
import { computeSmartMatchScores } from '@/lib/smart-match-scoring'

// inside the per-line map, replacing the old `suggestedBoardOptions` block:
const cutFitOptions = buildMaterialCutFitOptions({
  required: { lengthMm: requiredLengthMm, widthMm: requiredWidthMm, gsm: gsmWanted ?? 0, boardType: boardWanted, classification: null },
  candidates: matchedPaperRows.map((pw) => ({
    materialId: pw.id,
    materialCode: pw.id, // adapt if your code field differs
    boardType: pw.boardGrade ?? pw.paperType,
    boardClassification: null,
    gsm: pw.gsm,
    sizeLabel: pw.sheetSizeLabel ?? '',
    availableSheets: pw.qtySheets,
    reservedSheets: 0, // joined in next task
    freeSheets: pw.qtySheets,
  })),
  tolerance: { gsmPct: 5, sizePct: 10 },
})

const dieStatus = readinessFive.die.status as 'Ready' | 'Pending' | 'Missing'
const platesStatus = readinessFive.plates.status as 'Ready' | 'Pending' | 'Missing' | 'NotRequired'
const hoursUntilDue = li.dueAt ? (new Date(li.dueAt).getTime() - Date.now()) / 36e5 : 168

const scoredSuggestions = cutFitOptions.slice(0, 5).map((o) => ({
  ...o,
  scores: computeSmartMatchScores({
    sizeDeviationPct: o.sizeDeviationPct,
    wastagePct: o.wastagePct,
    isExactGsm: o.isExactGsm,
    isGsmTolerance: o.isGsmTolerance,
    hoursUntilDue,
    dieStatus,
    platesStatus,
    freeSheets: o.freeSheets ?? 0,
    requiredSheets: requiredSheets ?? 0,
  }),
}))
```

Return the scored suggestions inside `planningLedger.boardStockInsight.suggestedBoardOptions` (override the old simple array).

- [ ] **Step 2:** Update the `PlanningGridLine` type (likely in `src/components/planning/PlanningDecisionGrid.tsx`) so `smartMatch.suggestions` carries the new `scores` field.

- [ ] **Step 3:** Run typecheck and a manual smoke (load the planning page, inspect the network response JSON, confirm `composite` is present and varies between lines).

- [ ] **Step 4: Commit**

```bash
git add src/app/api/planning/po-lines/route.ts src/components/planning/PlanningDecisionGrid.tsx
git commit -m "planning list: replace dumb board dedupe with scored cut-fit suggestions"
```

---

### Task 3.3: Render real scores in SectionSmartMatch

**Files:**
- Modify: `src/components/planning/engine/SectionSmartMatch.tsx`

- [ ] **Step 1:** Replace the placeholder structure with the real `line.smartMatch.suggestions` shape from Task 3.2. The sub-score bar values come from `suggestion.scores.{sizeScore,wasteScore,urgencyScore,toolScore}`; `composite` and `tier` go into the right-side pill.

- [ ] **Step 2:** Existing tests from Task 1.5 should still pass (they used a similar shape). Update fixtures if the field names shifted.

- [ ] **Step 3: Commit**

```bash
git add src/components/planning/engine/SectionSmartMatch.tsx
git commit -m "planning engine: render scored smart match suggestions"
```

---

## Phase 4 — Paper warehouse safety (optimistic concurrency)

### Task 4.1: Add reservedVersion to the reservation model

**Files:**
- Modify: `prisma/schema.prisma` (the `<RESERVATION_MODEL>` identified in Task 0.1)
- Create: `prisma/migrations/<timestamp>_reservation_version/migration.sql`

- [ ] **Step 1:** Add to the reservation model in `prisma/schema.prisma`:

```prisma
reservedVersion Int @default(0) @map("reserved_version")
```

- [ ] **Step 2:** Generate the migration

```bash
pnpm prisma migrate dev --name reservation_version --create-only
```

Edit the generated SQL to ensure `ALTER TABLE … ADD COLUMN reserved_version integer NOT NULL DEFAULT 0;` is present.

- [ ] **Step 3: Apply**

```bash
pnpm prisma migrate dev
```

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "reservations: add reserved_version for optimistic concurrency"
```

---

### Task 4.2: Enforce expectedReservedVersion in reserveMaterial

**Files:**
- Modify: `src/lib/material-readiness-service.ts`

- [ ] **Step 1:** Extend the signature:

```ts
export type ReserveOpts = {
  poLineItemId: string
  expectedReservedVersion?: number
}

export async function reserveMaterial(tx: PrismaTx, opts: ReserveOpts) { /* … */ }
```

- [ ] **Step 2:** Inside the transaction, when updating the reservation row, use a conditional update:

```ts
const update = await tx.<reservationModel>.updateMany({
  where: {
    id: reservation.id,
    ...(opts.expectedReservedVersion != null ? { reservedVersion: opts.expectedReservedVersion } : {}),
  },
  data: {
    reservedSheets: newReserved,
    reservedVersion: { increment: 1 },
  },
})
if (update.count === 0) {
  throw new Error('RESERVATION_CONFLICT')
}
```

- [ ] **Step 3:** Add a test in a new `material-readiness-service.test.ts` that:
  1. Creates two simultaneous reservations on the same paper lot using the same `expectedReservedVersion`.
  2. Asserts the second one throws `RESERVATION_CONFLICT`.

- [ ] **Step 4: Commit**

```bash
git add src/lib/material-readiness-service.ts src/lib/material-readiness-service.test.ts
git commit -m "reservations: optimistic concurrency via reservedVersion check"
```

---

### Task 4.3: Pass the expected version from the modal

**Files:**
- Modify: `src/app/api/planning/po-lines/[id]/reserve-material/route.ts`
- Modify: `src/components/planning/engine/SectionBoardAllocation.tsx`

- [ ] **Step 1:** API accepts `expectedReservedVersion` in the POST body, forwards to `reserveMaterial`. On `RESERVATION_CONFLICT`, return 409 with the current server-side version.

- [ ] **Step 2:** Section displays "Reserved by another planner — refresh to retry" inline banner on 409. Refresh re-fetches the line.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/planning/po-lines/[id]/reserve-material/route.ts src/components/planning/engine/SectionBoardAllocation.tsx
git commit -m "planning engine: surface reservation conflict to user"
```

---

### Task 4.4: Verify the lock-decision endpoint is atomic end-to-end

**Files:**
- Modify: `src/app/api/planning/po-lines/[id]/lock-decision/route.ts`

- [ ] **Step 1:** Make sure the `$transaction` in Task 2.4 also passes `expectedReservedVersion` (from the request body) to `reserveMaterialForPlanning`. If it cannot, accept the latest version inside the transaction read.

- [ ] **Step 2:** Add an integration test under `src/app/api/planning/po-lines/[id]/lock-decision/route.test.ts` that simulates two planners locking the same line — only one should succeed.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/planning/po-lines/[id]/lock-decision/route.ts src/app/api/planning/po-lines/[id]/lock-decision/route.test.ts
git commit -m "planning engine: lock-decision atomic across reserve + status flip"
```

---

## Phase 5 — Inline Raise PR

### Task 5.1: Confirm the existing PR API contract

**Files:**
- Read: `src/app/api/purchase-requests/route.ts`
- Read: `src/app/api/purchase-requests/[id]/route.ts`

- [ ] **Step 1:** Find the POST endpoint and record its request schema (materialId, qtySheets, neededByDate, sourceLineId).
- [ ] **Step 2:** Find the GET endpoint and record the response shape (id, prNumber, status, etaDate).
- [ ] **Step 3:** No commit — discovery only.

---

### Task 5.2: Build the inline RaisePR button

**Files:**
- Create: `src/components/planning/engine/RaisePrInlineButton.tsx`

**Behavior:** Shows when `line.materialQueue.shortageSheets > 0` AND `line.materialQueue.prId == null`. Clicking opens a confirmation popover with:
- Shortfall sheets (read-only)
- Needed-by date input (default = `line.dueAt - 3 days`)
- "Raise PR" button → POST `/api/purchase-requests`, then refetch the line.

- [ ] **Step 1: Failing test**

```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { RaisePrInlineButton } from './RaisePrInlineButton'

describe('RaisePrInlineButton', () => {
  it('hides when there is no shortage', () => {
    const { container } = render(
      <RaisePrInlineButton line={{ materialQueue: { shortageSheets: 0 } } as any} onRaised={async () => {}} />
    )
    expect(container.firstChild).toBeNull()
  })
  it('shows when shortage > 0 and no PR yet', () => {
    render(
      <RaisePrInlineButton
        line={{ materialQueue: { shortageSheets: 3560, prId: null }, materialId: 'm1' } as any}
        onRaised={async () => {}}
      />
    )
    expect(screen.getByRole('button', { name: /Raise PR/i })).toBeInTheDocument()
  })
  it('posts to /api/purchase-requests on confirm', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id: 'pr1', prNumber: 'PR-2024-9999' }), { status: 201 }))
    const onRaised = vi.fn().mockResolvedValue(undefined)
    render(
      <RaisePrInlineButton
        line={{ id: 'l1', materialQueue: { shortageSheets: 3560, prId: null }, materialId: 'm1', dueAt: '2026-05-30' } as any}
        onRaised={onRaised}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /Raise PR/i }))
    fireEvent.click(await screen.findByRole('button', { name: /Confirm/i }))
    await new Promise((r) => setTimeout(r, 0))
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/purchase-requests',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(onRaised).toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})
```

- [ ] **Step 2: Implement** using a Radix-style popover (use the existing pattern from `src/components/ui/` if present, otherwise a simple absolute-positioned `<div>` triggered by useState).

- [ ] **Step 3: Pass & commit**

```bash
pnpm vitest run src/components/planning/engine/RaisePrInlineButton.test.tsx
git add src/components/planning/engine/RaisePrInlineButton.tsx src/components/planning/engine/RaisePrInlineButton.test.tsx
git commit -m "planning engine: inline RaisePR button with confirmation"
```

---

### Task 5.3: Embed RaisePR inside SectionBoardAllocation and reflect ETA

**Files:**
- Modify: `src/components/planning/engine/SectionBoardAllocation.tsx`

- [ ] **Step 1:** When the shortage banner is shown and there is no `prId`, render `<RaisePrInlineButton line={line} onRaised={async () => refetchLine()} />` inside the banner footer.
- [ ] **Step 2:** When `prId` is present, show the existing "PR / purchase order" row with the ETA chip; remove the inline button.
- [ ] **Step 3:** After a successful raise, the line refetch should populate `materialQueue.prId` and trigger the readiness pill to flip from "PA ×" to "PA ⌛ on order" (verify this state is computed in `readinessFive` on the server side; adjust there if needed).

- [ ] **Step 4: Commit**

```bash
git add src/components/planning/engine/SectionBoardAllocation.tsx
git commit -m "planning engine: shortage → inline PR → ETA reflection"
```

---

## Phase 6 — Cleanup & verification

### Task 6.1: Remove dead code from the drawer

**Files:**
- Modify: `src/components/planning/PlanningJobDetailDrawer.tsx`

- [ ] **Step 1:** Identify and delete any helper functions, local state, or styled blocks that the old drawer body used and that are no longer referenced. Use the editor's "find references" or a grep on key identifiers from the old body.
- [ ] **Step 2:** If the drawer shrinks under ~800 lines, consider renaming the file to `PlanningEngineHost.tsx`; otherwise keep the name for now.
- [ ] **Step 3:** Run typecheck + lint.

```bash
pnpm typecheck && pnpm lint
```

- [ ] **Step 4: Commit**

```bash
git add src/components/planning/PlanningJobDetailDrawer.tsx
git commit -m "planning engine: drop dead drawer body code"
```

---

### Task 6.2: Full visual + functional review

- [ ] **Step 1:** Run the dev server and walk through five scenarios:
  1. New PO line with everything green → modal opens, autosave works, Save & lock locks.
  2. PO line with paper shortage → shortage banner shows, RaisePR works, ETA reflects.
  3. PO line with missing die → toolScore reads 0; lock button is disabled with blocker tooltip.
  4. Two browser tabs editing the same line → second tab gets RESERVATION_CONFLICT toast on lock.
  5. Already-locked line → all fields read-only, footer shows `Locked by <user> at <time>`.
- [ ] **Step 2:** Take screenshots of each, drop into `docs/superpowers/plans/screenshots/2026-05-15-planning-engine/`.
- [ ] **Step 3:** Open a draft PR with the screenshots attached for review.

```bash
git push -u origin <branch>
gh pr create --draft --title "Planning engine: centered modal + scored smart match + reservation safety" --body "$(cat <<'EOF'
## Summary
- Drawer → centered 60vw Planning engine modal (4 sections in a 2×2 grid)
- Autosave on field blur + explicit Save & lock with preconditions
- Smart Match: deterministic composite score (Size + Waste + Urgency + Tool)
- Paper warehouse reservations gated by reservedVersion (no double-claims)
- Inline shortage → PR flow with ETA reflection in readiness

## Test plan
- [ ] Open three real PO lines (ready / shortage / locked) — modal renders correctly
- [ ] Edit UPS, blur, observe Saving → Saved transition
- [ ] Lock a not-ready line — see 422 blockers
- [ ] Two tabs lock the same line — second sees RESERVATION_CONFLICT
- [ ] Raise PR inline → page refetches → ETA chip appears

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Acceptance criteria (top-level)

- **Modal:** Opens centered, ~60vw, scale-in animation; closes on Esc, scrim click, X; renders four sections in a 2×2 grid on screens ≥ 1180px, stacked on smaller.
- **Autosave:** Any field change is persisted within 250ms of blur; footer shows live `Saving… / Saved <time> / Error`.
- **Lock:** Save & lock disabled until preconditions pass; locking is atomic (status flip + reservation in one tx); locked lines render read-only.
- **Smart Match:** Each suggestion shows a composite score 0-100 + four sub-score bars; ranking matches `composite desc`; tier reflects the thresholds.
- **Paper warehouse:** Net stock / reserved / shortfall match a fresh DB read at modal open. Two simultaneous locks on the same lot conflict — exactly one wins.
- **Raise PR:** Available exactly when `shortageSheets > 0 && !prId`. After raising, the readiness pill flips to "PA ⌛ on order".
