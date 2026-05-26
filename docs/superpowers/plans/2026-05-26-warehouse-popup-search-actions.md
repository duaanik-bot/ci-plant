# Warehouse Popup Search + Inline Row Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a localized search bar and per-row Select/Reserve/Release actions to the planning-engine `WarehousePopup`, and verify the popup always closes.

**Architecture:** `WarehousePopup` stays presentational — it filters the already-loaded rows client-side (tab AND search) and delegates all mutations to callbacks. `PlanningJobDetailDrawer` owns the reserve/release handlers (calling the existing `reservation-control` API with `adjust`/`release`) and a per-line "reserved sheets by material" map, refreshed after each action. A shared `getPlanningReservedByMaterial` helper is extracted into `material-readiness-service` and surfaced through `reservation-control` GET.

**Tech Stack:** Next.js (App Router) API routes, React + TypeScript, Tailwind (`ds-*` design tokens), Vitest + Testing Library, Prisma.

---

## File Structure

- **Modify** `src/lib/material-readiness-service.ts` — add exported `getPlanningReservedByMaterial(planningLineId, materialIds?)`.
- **Modify** `src/app/api/planning/po-lines/[id]/reserve-material/route.ts` — use the shared helper (delete the local copy).
- **Modify** `src/app/api/planning/po-lines/[id]/reservation-control/route.ts` — GET returns `{ reservedByMaterial }` when no `materialId` is given.
- **Create** `src/app/api/planning/po-lines/[id]/reservation-control/route.test.ts` — GET map test.
- **Modify** `src/components/planning/engine/WarehousePopup.tsx` — search bar, Actions column, inline qty editor, new optional props.
- **Modify** `src/components/planning/engine/WarehousePopup.test.tsx` — search + action tests.
- **Modify** `src/components/planning/PlanningJobDetailDrawer.tsx` — reserved-by-material state + fetch, reserve/release handlers, pass props to `WarehousePopup`.

---

## Task 1: Extract `getPlanningReservedByMaterial` into the service

**Files:**
- Modify: `src/lib/material-readiness-service.ts`
- Modify: `src/app/api/planning/po-lines/[id]/reserve-material/route.ts:88-117`

A private copy of this aggregation lives in the `reserve-material` route. Move it to the service (exported, `materialIds` optional → full-line map) and reuse it.

- [ ] **Step 1: Add the exported helper to the service**

Append to `src/lib/material-readiness-service.ts` (the file already has `import { db } from '@/lib/db'`):

```ts
/**
 * Net planning reservation (sheets) per material for one planning line,
 * derived from the stock-movement ledger. Omit `materialIds` to get the
 * full map for the line.
 */
export async function getPlanningReservedByMaterial(
  planningLineId: string,
  materialIds?: string[],
): Promise<Record<string, number>> {
  if (!planningLineId) return {}
  const rows = await db.stockMovement.findMany({
    where: {
      refId: planningLineId,
      ...(materialIds && materialIds.length > 0 ? { materialId: { in: materialIds } } : {}),
      refType: {
        in: ['planning_reserve', 'planning_adjust_increase', 'planning_release', 'planning_adjust_decrease'],
      },
    },
    select: { materialId: true, refType: true, qty: true },
  })
  const out: Record<string, number> = {}
  for (const row of rows) {
    const qty = Number(row.qty) || 0
    const sign =
      row.refType === 'planning_release' || row.refType === 'planning_adjust_decrease' ? -1 : 1
    out[row.materialId] = Math.max(0, (out[row.materialId] || 0) + sign * qty)
  }
  return out
}
```

- [ ] **Step 2: Use the shared helper in the reserve-material route**

In `src/app/api/planning/po-lines/[id]/reserve-material/route.ts`, delete the local `async function getPlanningReservedByMaterial(...) { ... }` block (lines ~88-117) and add it to the existing import from `@/lib/material-readiness-service` (currently imports `calculateRequirement, createShortage, reserveMaterial, reserveMaterialForPlanning, ShortagePrRecoveryError`):

```ts
import {
  calculateRequirement,
  createShortage,
  getPlanningReservedByMaterial,
  reserveMaterial,
  reserveMaterialForPlanning,
  ShortagePrRecoveryError,
} from '@/lib/material-readiness-service'
```

Leave all call sites (`getPlanningReservedByMaterial(...)`) unchanged — the signature is compatible.

- [ ] **Step 3: Run the existing reserve-material route tests (they exercise the moved function)**

Run: `npx vitest run src/app/api/planning/po-lines/\[id\]/reserve-material/route.test.ts`
Expected: PASS (same count as before — the move is behavior-preserving).

- [ ] **Step 4: Typecheck the two files compile**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "reserve-material|material-readiness-service" || echo "no type errors in touched files"`
Expected: `no type errors in touched files`

- [ ] **Step 5: Commit**

```bash
git add src/lib/material-readiness-service.ts "src/app/api/planning/po-lines/[id]/reserve-material/route.ts"
git commit -m "refactor: share getPlanningReservedByMaterial from material-readiness-service"
```

---

## Task 2: `reservation-control` GET returns the per-line reserved map

**Files:**
- Modify: `src/app/api/planning/po-lines/[id]/reservation-control/route.ts:30-48`
- Create: `src/app/api/planning/po-lines/[id]/reservation-control/route.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/app/api/planning/po-lines/[id]/reservation-control/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/helpers', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/material-readiness-service', () => ({
  adjustPlanningReservation: vi.fn(),
  generatePrForPlanningShortage: vi.fn(),
  getPlanningReservationSnapshot: vi.fn(),
  releasePlanningReservation: vi.fn(),
  getPlanningReservedByMaterial: vi.fn(),
}))

import { GET } from './route'
import { requireAuth } from '@/lib/helpers'
import { getPlanningReservedByMaterial } from '@/lib/material-readiness-service'

const params = Promise.resolve({ id: 'line-1' })

beforeEach(() => {
  vi.mocked(requireAuth).mockReset()
  vi.mocked(getPlanningReservedByMaterial).mockReset()
})

it('returns the per-line reservedByMaterial map when no materialId is given', async () => {
  vi.mocked(requireAuth).mockResolvedValue({ error: null } as never)
  vi.mocked(getPlanningReservedByMaterial).mockResolvedValue({ 'mat-001': 500, 'mat-002': 250 } as never)

  const req = new Request('http://localhost/api/planning/po-lines/line-1/reservation-control')
  const res = await GET(req as never, { params } as never)
  const json = await res.json()

  expect(res.status).toBe(200)
  expect(json.success).toBe(true)
  expect(json.reservedByMaterial).toEqual({ 'mat-001': 500, 'mat-002': 250 })
  expect(vi.mocked(getPlanningReservedByMaterial)).toHaveBeenCalledWith('line-1')
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run "src/app/api/planning/po-lines/[id]/reservation-control/route.test.ts"`
Expected: FAIL — current GET returns `fail('No material selected')` (400), so `res.status` is 400 and `reservedByMaterial` is undefined.

- [ ] **Step 3: Implement the GET branch**

In `src/app/api/planning/po-lines/[id]/reservation-control/route.ts`, add `getPlanningReservedByMaterial` to the existing service import, then replace the `GET` body (lines 30-48) with:

```ts
export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { error } = await requireAuth()
  if (error) return error

  const { id: planningId } = await context.params
  if (!planningId) return fail('Planning context missing')

  const { searchParams } = new URL(req.url)
  const materialId = searchParams.get('materialId')?.trim() || ''

  // No materialId → return the full per-material reserved map for this line.
  if (!materialId) {
    try {
      const reservedByMaterial = await getPlanningReservedByMaterial(planningId)
      return NextResponse.json({ success: true, reservedByMaterial })
    } catch (e) {
      return fail(e instanceof Error ? e.message : 'Failed to load reservations', 400)
    }
  }

  const requiredSheets = Math.max(0, Math.floor(asNum(searchParams.get('requiredSheets'))))
  if (!requiredSheets) return fail('Invalid required sheets')

  try {
    const snapshot = await getPlanningReservationSnapshot(planningId, materialId, requiredSheets)
    return NextResponse.json({ success: true, ...snapshot })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to load reservation snapshot', 400)
  }
}
```

The import block at the top becomes:

```ts
import {
  adjustPlanningReservation,
  generatePrForPlanningShortage,
  getPlanningReservationSnapshot,
  getPlanningReservedByMaterial,
  releasePlanningReservation,
} from '@/lib/material-readiness-service'
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run "src/app/api/planning/po-lines/[id]/reservation-control/route.test.ts"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/planning/po-lines/[id]/reservation-control/route.ts" "src/app/api/planning/po-lines/[id]/reservation-control/route.test.ts"
git commit -m "feat(planning): reservation-control GET returns per-line reserved-by-material map"
```

---

## Task 3: WarehousePopup — localized search bar

**Files:**
- Modify: `src/components/planning/engine/WarehousePopup.tsx`
- Test: `src/components/planning/engine/WarehousePopup.test.tsx`

- [ ] **Step 1: Write the failing tests**

Add to `src/components/planning/engine/WarehousePopup.test.tsx` inside the `describe('WarehousePopup', ...)` block:

```ts
it('filters rows by the search box (matches code/board/gsm/size)', async () => {
  render(<WarehousePopup open onClose={() => {}} readiness={readiness} />)
  await screen.findByText('ITC-FBB-300')

  fireEvent.change(screen.getByLabelText('Search warehouse stock'), { target: { value: 'SBS' } })

  expect(screen.getByText('SBS-250-STD')).toBeInTheDocument()
  expect(screen.queryByText('ITC-FBB-300')).not.toBeInTheDocument()
  expect(screen.queryByText('FBB-310-A')).not.toBeInTheDocument()
})

it('composes search with the active tab (AND)', async () => {
  render(<WarehousePopup open onClose={() => {}} readiness={readiness} />)
  await screen.findByText('ITC-FBB-300')

  fireEvent.click(screen.getByRole('button', { name: 'Free' })) // mat-001 only has free stock
  fireEvent.change(screen.getByLabelText('Search warehouse stock'), { target: { value: '310' } }) // would match mat-003

  // mat-003 matches the search but has 0 free → excluded by the Free tab
  expect(screen.getByText('No rows to display.')).toBeInTheDocument()
})

it('clear button resets the search', async () => {
  render(<WarehousePopup open onClose={() => {}} readiness={readiness} />)
  await screen.findByText('ITC-FBB-300')

  fireEvent.change(screen.getByLabelText('Search warehouse stock'), { target: { value: 'SBS' } })
  expect(screen.queryByText('ITC-FBB-300')).not.toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
  expect(screen.getByText('ITC-FBB-300')).toBeInTheDocument()
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/components/planning/engine/WarehousePopup.test.tsx -t "search"`
Expected: FAIL — `getByLabelText('Search warehouse stock')` not found.

- [ ] **Step 3: Implement the search bar + filter**

In `src/components/planning/engine/WarehousePopup.tsx`, add a search state in the component (next to `activeTab`):

```ts
  const [search, setSearch] = useState('')
```

After the existing `filtered` IIFE, add a search predicate applied on top:

```ts
  const q = search.trim().toLowerCase()
  const visible: WarehouseRow[] = q
    ? filtered.filter((r) =>
        [r.material_code ?? '', r.board_type_id ?? '', r.gsm != null ? String(r.gsm) : '', r.size_display]
          .join(' ')
          .toLowerCase()
          .includes(q),
      )
    : filtered
```

Render a search input between the tab bar `</div>` and the `{/* Content */}` block, and pass `visible` (not `filtered`) to `RowTable`:

```tsx
      {/* Search */}
      <div className="mb-3 flex items-center gap-2">
        <input
          type="text"
          aria-label="Search warehouse stock"
          placeholder="Search code, board, GSM, size…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full rounded-ds-sm border border-ds-line/40 bg-ds-elevated px-3 py-1.5 text-xs text-ds-ink placeholder:text-ds-ink-faint outline-none focus:border-ds-brand/50"
        />
        {search ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => setSearch('')}
            className="shrink-0 rounded-ds-sm border border-ds-line/40 bg-ds-elevated px-2 py-1.5 text-xs text-ds-ink-muted hover:text-ds-ink"
          >
            ✕
          </button>
        ) : null}
      </div>

      {/* Content */}
      {loading ? (
        <div className="py-8 text-center text-sm text-ds-ink-faint">Loading…</div>
      ) : (
        <RowTable rows={visible} />
      )}
```

- [ ] **Step 4: Run the search tests to verify they pass**

Run: `npx vitest run src/components/planning/engine/WarehousePopup.test.tsx -t "search"`
Expected: PASS (3 tests)

- [ ] **Step 5: Run the whole popup test file (no regressions)**

Run: `npx vitest run src/components/planning/engine/WarehousePopup.test.tsx`
Expected: PASS (all existing + 3 new)

- [ ] **Step 6: Commit**

```bash
git add src/components/planning/engine/WarehousePopup.tsx src/components/planning/engine/WarehousePopup.test.tsx
git commit -m "feat(planning): localized search bar in warehouse popup"
```

---

## Task 4: WarehousePopup — inline Select/Reserve/Release actions

**Files:**
- Modify: `src/components/planning/engine/WarehousePopup.tsx`
- Test: `src/components/planning/engine/WarehousePopup.test.tsx`

New optional props drive a right-aligned Actions column. Reserve reveals an inline qty editor pre-filled with `min(lineRequiredSheets, rowFree)`, clamped to `[1, rowFree]`.

- [ ] **Step 1: Write the failing tests**

Add to `src/components/planning/engine/WarehousePopup.test.tsx`:

```ts
it('Select calls onSelect with the row material id', async () => {
  const onSelect = vi.fn()
  render(<WarehousePopup open onClose={() => {}} readiness={readiness} onSelect={onSelect} />)
  await screen.findByText('SBS-250-STD')

  fireEvent.click(screen.getByRole('button', { name: 'Select SBS-250-STD' }))
  expect(onSelect).toHaveBeenCalledWith('mat-002')
})

it('Reserve reveals an editor pre-filled with min(required, free) and confirms the clamped qty', async () => {
  const onReserve = vi.fn()
  // line needs 5000; mat-001 free = 6000 → prefill 5000
  render(
    <WarehousePopup open onClose={() => {}} readiness={readiness} lineRequiredSheets={5000} onReserve={onReserve} />,
  )
  await screen.findByText('ITC-FBB-300')

  fireEvent.click(screen.getByRole('button', { name: 'Reserve ITC-FBB-300' }))
  const input = screen.getByLabelText('Reserve sheets') as HTMLInputElement
  expect(input.value).toBe('5000')

  fireEvent.click(screen.getByRole('button', { name: 'Confirm reserve' }))
  expect(onReserve).toHaveBeenCalledWith('mat-001', 5000)
})

it('Reserve clamps qty above free down to free', async () => {
  const onReserve = vi.fn()
  // mat-002 free = 0 → Reserve button disabled; use mat-001, type above free
  render(
    <WarehousePopup open onClose={() => {}} readiness={readiness} lineRequiredSheets={5000} onReserve={onReserve} />,
  )
  await screen.findByText('ITC-FBB-300')

  fireEvent.click(screen.getByRole('button', { name: 'Reserve ITC-FBB-300' }))
  fireEvent.change(screen.getByLabelText('Reserve sheets'), { target: { value: '99999' } })
  fireEvent.click(screen.getByRole('button', { name: 'Confirm reserve' }))
  expect(onReserve).toHaveBeenCalledWith('mat-001', 6000) // free = 8000 - 2000
})

it('Release is disabled when this line reserved 0 of the material, enabled otherwise', async () => {
  const onUnreserve = vi.fn()
  render(
    <WarehousePopup
      open
      onClose={() => {}}
      readiness={readiness}
      lineReservedByMaterial={{ 'mat-001': 1200 }}
      onUnreserve={onUnreserve}
    />,
  )
  await screen.findByText('ITC-FBB-300')

  // mat-002 → 0 reserved by this line → disabled
  expect(screen.getByRole('button', { name: 'Release SBS-250-STD' })).toBeDisabled()

  // mat-001 → 1200 reserved → enabled, releases
  fireEvent.click(screen.getByRole('button', { name: 'Release ITC-FBB-300' }))
  expect(onUnreserve).toHaveBeenCalledWith('mat-001')
})

it('marks the linked material row as selected', async () => {
  render(<WarehousePopup open onClose={() => {}} readiness={readiness} onSelect={vi.fn()} />)
  await screen.findByText('ITC-FBB-300')

  // readiness.materialId === 'mat-001' → its Select control reads "Selected"
  expect(screen.getByRole('button', { name: 'Selected ITC-FBB-300' })).toBeInTheDocument()
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/components/planning/engine/WarehousePopup.test.tsx -t "Select|Reserve|Release|selected"`
Expected: FAIL — action controls/props don't exist yet.

- [ ] **Step 3: Add the new props to the component type**

In `src/components/planning/engine/WarehousePopup.tsx`, extend `WarehousePopupProps`:

```ts
export type WarehousePopupProps = {
  open: boolean
  onClose: () => void
  lineBoardType?: string | null
  lineGsm?: number | null
  readiness: PlanningEngineReadiness | null
  gsmTolerance?: number
  lineRequiredSheets?: number
  lineReservedByMaterial?: Record<string, number>
  onSelect?: (materialId: string) => Promise<void> | void
  onReserve?: (materialId: string, qty: number) => Promise<void> | void
  onUnreserve?: (materialId: string) => Promise<void> | void
}
```

- [ ] **Step 4: Rewrite `RowTable` with the Actions column + inline editor**

Replace the entire `RowTable` function in `src/components/planning/engine/WarehousePopup.tsx` with:

```tsx
function RowTable({
  rows,
  selectedMaterialId,
  lineRequiredSheets,
  lineReservedByMaterial,
  onSelect,
  onReserve,
  onUnreserve,
}: {
  rows: WarehouseRow[]
  selectedMaterialId: string | null
  lineRequiredSheets: number
  lineReservedByMaterial: Record<string, number>
  onSelect?: (materialId: string) => Promise<void> | void
  onReserve?: (materialId: string, qty: number) => Promise<void> | void
  onUnreserve?: (materialId: string) => Promise<void> | void
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [qty, setQty] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)

  async function run(materialId: string, fn?: () => Promise<void> | void) {
    if (!fn) return
    setBusy(materialId)
    try {
      await fn()
    } finally {
      setBusy(null)
      setEditing(null)
    }
  }

  if (rows.length === 0) {
    return <div className="py-8 text-center text-sm text-ds-ink-faint">No rows to display.</div>
  }

  const btn =
    'rounded-ds-sm border px-2 py-0.5 text-[11px] font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed'

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-ds-line/30 text-left text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint">
            <th className="pb-2 pr-3">Material code</th>
            <th className="pb-2 pr-3">Board type</th>
            <th className="pb-2 pr-3 text-right">GSM</th>
            <th className="pb-2 pr-3">Size</th>
            <th className="pb-2 pr-3 text-right">Available</th>
            <th className="pb-2 pr-3 text-right">Reserved</th>
            <th className="pb-2 pr-3 text-right">Free</th>
            <th className="pb-2 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const free = Math.max(0, r.available_sheets - r.reserved_sheets)
            const code = r.material_code ?? r.material_id
            const selected = r.material_id === selectedMaterialId
            const lineReserved = lineReservedByMaterial[r.material_id] ?? 0
            const rowBusy = busy === r.material_id
            return (
              <tr
                key={r.material_id}
                className={`border-b border-ds-line/15 transition-colors ${
                  selected ? 'bg-ds-brand/[0.06] ring-1 ring-inset ring-ds-brand/30' : 'hover:bg-ds-elevated/50'
                }`}
              >
                <td className="py-2 pr-3 font-mono font-medium text-ds-ink">{r.material_code ?? '—'}</td>
                <td className="py-2 pr-3 text-ds-ink-muted">{r.board_type_id ?? '—'}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-ds-ink-muted">{r.gsm ?? '—'}</td>
                <td className="py-2 pr-3 text-ds-ink-muted">{r.size_display}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-ds-ink">{fmt(r.available_sheets)}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-ds-ink-muted">{fmt(r.reserved_sheets)}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-emerald-400">{fmt(free)}</td>
                <td className="py-2 text-right">
                  {editing === r.material_id ? (
                    <span className="inline-flex items-center justify-end gap-1">
                      <input
                        type="number"
                        aria-label="Reserve sheets"
                        value={qty}
                        min={1}
                        max={free}
                        onChange={(e) => setQty(Number(e.target.value) || 0)}
                        className="w-20 rounded-ds-sm border border-ds-line/40 bg-ds-elevated px-1.5 py-0.5 text-right text-[11px] text-ds-ink outline-none focus:border-ds-brand/50"
                      />
                      <button
                        type="button"
                        aria-label="Confirm reserve"
                        disabled={rowBusy}
                        onClick={() =>
                          void run(r.material_id, () =>
                            onReserve?.(r.material_id, Math.max(1, Math.min(qty, free))),
                          )
                        }
                        className={`${btn} border-emerald-500/40 bg-emerald-500/15 text-emerald-300`}
                      >
                        ✓
                      </button>
                      <button
                        type="button"
                        aria-label="Cancel reserve"
                        onClick={() => setEditing(null)}
                        className={`${btn} border-ds-line/40 bg-ds-elevated text-ds-ink-muted`}
                      >
                        ✕
                      </button>
                    </span>
                  ) : (
                    <span className="inline-flex items-center justify-end gap-1.5">
                      <button
                        type="button"
                        aria-label={`${selected ? 'Selected' : 'Select'} ${code}`}
                        disabled={rowBusy || selected || !onSelect}
                        onClick={() => void run(r.material_id, () => onSelect?.(r.material_id))}
                        className={`${btn} ${
                          selected
                            ? 'border-ds-brand/50 bg-ds-brand/15 text-ds-brand'
                            : 'border-ds-line/40 bg-ds-elevated text-ds-ink-muted hover:text-ds-ink'
                        }`}
                      >
                        {selected ? 'Selected' : 'Select'}
                      </button>
                      <button
                        type="button"
                        aria-label={`Reserve ${code}`}
                        disabled={rowBusy || free <= 0 || !onReserve}
                        onClick={() => {
                          setQty(Math.max(1, Math.min(lineRequiredSheets || 0, free) || 1))
                          setEditing(r.material_id)
                        }}
                        className={`${btn} border-ds-brand/40 bg-ds-brand/10 text-ds-brand hover:bg-ds-brand/20`}
                      >
                        Reserve
                      </button>
                      <button
                        type="button"
                        aria-label={`Release ${code}`}
                        disabled={rowBusy || lineReserved <= 0 || !onUnreserve}
                        onClick={() => void run(r.material_id, () => onUnreserve?.(r.material_id))}
                        className={`${btn} border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20`}
                      >
                        Release
                      </button>
                    </span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
```

- [ ] **Step 5: Pass the new props from the component into `RowTable`**

In the `WarehousePopup` function, destructure the new props (with defaults) and pass them down. Update the signature:

```ts
export function WarehousePopup({
  open,
  onClose,
  lineBoardType,
  lineGsm,
  readiness,
  gsmTolerance = 10,
  lineRequiredSheets = 0,
  lineReservedByMaterial = {},
  onSelect,
  onReserve,
  onUnreserve,
}: WarehousePopupProps) {
```

And the `RowTable` usage in the Content block:

```tsx
        <RowTable
          rows={visible}
          selectedMaterialId={readiness?.materialId ?? null}
          lineRequiredSheets={lineRequiredSheets}
          lineReservedByMaterial={lineReservedByMaterial}
          onSelect={onSelect}
          onReserve={onReserve}
          onUnreserve={onUnreserve}
        />
```

- [ ] **Step 6: Run the action tests to verify they pass**

Run: `npx vitest run src/components/planning/engine/WarehousePopup.test.tsx`
Expected: PASS (all existing + search + 5 action tests)

- [ ] **Step 7: Typecheck the component**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "WarehousePopup" || echo "no type errors in WarehousePopup"`
Expected: `no type errors in WarehousePopup`

- [ ] **Step 8: Commit**

```bash
git add src/components/planning/engine/WarehousePopup.tsx src/components/planning/engine/WarehousePopup.test.tsx
git commit -m "feat(planning): inline Select/Reserve/Release row actions in warehouse popup"
```

---

## Task 5: Wire the drawer — handlers, reserved map, props

**Files:**
- Modify: `src/components/planning/PlanningJobDetailDrawer.tsx`

This file has no unit-test harness; verification is typecheck (here) + browser preview (Task 6). `toast`, `useCallback`, and `loadReadiness` are already imported/defined and used by the sibling handlers.

- [ ] **Step 1: Add the reserved-by-material state and refresher**

Near the other `useState` hooks (e.g. after `const [warehousePopupOpen, setWarehousePopupOpen] = useState(false)` at line ~383):

```ts
  const [lineReservedByMaterial, setLineReservedByMaterial] = useState<Record<string, number>>({})

  const refreshReservedByMaterial = useCallback(async () => {
    if (!line?.id) return
    try {
      const res = await fetch(`/api/planning/po-lines/${line.id}/reservation-control`, { cache: 'no-store' })
      if (!res.ok) {
        setLineReservedByMaterial({})
        return
      }
      const data = (await res.json().catch(() => ({}))) as { reservedByMaterial?: Record<string, number> }
      setLineReservedByMaterial(data.reservedByMaterial ?? {})
    } catch {
      setLineReservedByMaterial({})
    }
  }, [line?.id])
```

- [ ] **Step 2: Add the reserve/release handlers**

Place these next to `handleEngineUnreserve` (~line 1583):

```ts
  const handleWarehouseReserve = useCallback(
    async (materialId: string, qty: number) => {
      if (!line?.id) return
      const requiredSheets = Math.max(0, Math.floor(Number(readiness?.requiredSheets ?? 0)))
      const current = lineReservedByMaterial[materialId] ?? 0
      const target = current + Math.max(0, Math.floor(qty))
      try {
        const res = await fetch(`/api/planning/po-lines/${line.id}/reservation-control`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'adjust',
            materialId,
            requiredSheets,
            targetReserveQty: target,
            prImpactAction: 'reduce',
          }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error((data as { message?: string }).message || 'Failed to reserve')
        toast.success('Reserved.')
        await Promise.all([loadReadiness(), refreshReservedByMaterial()])
        window.dispatchEvent(new Event('planning:refresh'))
        window.dispatchEvent(new Event('inventory:refresh'))
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Failed to reserve')
      }
    },
    [line?.id, readiness?.requiredSheets, lineReservedByMaterial, loadReadiness, refreshReservedByMaterial],
  )

  const handleWarehouseUnreserve = useCallback(
    async (materialId: string) => {
      if (!line?.id) return
      const releaseQty = lineReservedByMaterial[materialId] ?? 0
      if (releaseQty <= 0) {
        toast.error('No reserved stock to release for this material.')
        return
      }
      const requiredSheets = Math.max(0, Math.floor(Number(readiness?.requiredSheets ?? 0)))
      try {
        const res = await fetch(`/api/planning/po-lines/${line.id}/reservation-control`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'release',
            materialId,
            requiredSheets,
            releaseQty,
            prImpactAction: 'reduce',
          }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error((data as { message?: string }).message || 'Failed to release')
        toast.success('Reservation released.')
        await Promise.all([loadReadiness(), refreshReservedByMaterial()])
        window.dispatchEvent(new Event('planning:refresh'))
        window.dispatchEvent(new Event('inventory:refresh'))
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Failed to release')
      }
    },
    [line?.id, readiness?.requiredSheets, lineReservedByMaterial, loadReadiness, refreshReservedByMaterial],
  )
```

- [ ] **Step 3: Refresh the map when the popup opens**

Change the `onOpenWarehouse` prop on `<PlanningEngineBody>` (line ~1758):

```tsx
        onOpenWarehouse={() => {
          setWarehousePopupOpen(true)
          void refreshReservedByMaterial()
        }}
```

- [ ] **Step 4: Pass the new props to `<WarehousePopup>`**

Replace the `<WarehousePopup ... />` block (lines ~1761-1767) with:

```tsx
      <WarehousePopup
        open={warehousePopupOpen}
        onClose={() => setWarehousePopupOpen(false)}
        lineBoardType={readiness?.boardType ?? line.paperType ?? null}
        lineGsm={readiness?.gsm ?? line.gsm ?? null}
        readiness={readiness as unknown as PlanningEngineReadiness | null}
        lineRequiredSheets={Math.max(0, Math.floor(Number(readiness?.requiredSheets ?? 0)))}
        lineReservedByMaterial={lineReservedByMaterial}
        onSelect={handleEngineSelectBoard}
        onReserve={handleWarehouseReserve}
        onUnreserve={handleWarehouseUnreserve}
      />
```

- [ ] **Step 5: Typecheck the drawer**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "PlanningJobDetailDrawer" || echo "no type errors in drawer"`
Expected: `no type errors in drawer`

- [ ] **Step 6: Run the planning component test suite (no regressions)**

Run: `npx vitest run src/components/planning`
Expected: PASS (baseline + new popup tests).

- [ ] **Step 7: Commit**

```bash
git add src/components/planning/PlanningJobDetailDrawer.tsx
git commit -m "feat(planning): wire warehouse popup reserve/release/select to the line"
```

---

## Task 6: Browser-preview verification

**Files:** none (verification only)

- [ ] **Step 1: Start the dev server**

Use the preview tooling (`preview_start`). Note (per repo gotchas): `geist` can break `next dev` in a worktree — if the server fails to boot on a font/`geist` resolution error, run `npm install` in this worktree first, then retry.

- [ ] **Step 2: Open a planning line drawer → "Open warehouse"**

Navigate to the planning engine, open a line's job-detail drawer, and open the warehouse popup. Capture `preview_console_logs` and `preview_snapshot`.

- [ ] **Step 3: Verify close**

Confirm the header `X` is visible and reachable with the full list loaded; clicking it (and pressing `Esc`) closes the popup. If the top nav overlaps the header, bump `zIndexClass` on the `GlobalPopoutModal` in `WarehousePopup` (e.g. `z-[1200]`) and re-verify. Screenshot before/after.

- [ ] **Step 4: Verify search**

Type a code/board/GSM fragment; confirm the table narrows instantly and composes with the active tab; clear resets.

- [ ] **Step 5: Verify actions (golden path)**

On a row with free stock: Select → row shows "Selected" and links to the line. Reserve → inline editor pre-fills `min(required, free)`; confirm → toast, and Available/Reserved/Free + Release-enabled update live. Release → toast and counts revert. Watch `preview_network` for the `reservation-control` calls returning 200 and `preview_console_logs` for errors.

- [ ] **Step 6: Report**

Summarize verification with screenshots/log excerpts. If all green, the feature is complete and ready for review/merge into `staging-supabase`.

---

## Self-Review Notes

- **Spec coverage:** close (Task 6 verify + optional z-bump), search (Task 3), inline Select/Reserve/Release with editable qty defaulting to line requirement (Task 4), per-line reserved map + additive `adjust` / `release` wiring (Tasks 1, 2, 5), tests (Tasks 2-5). All spec sections map to a task.
- **Type consistency:** prop names `lineRequiredSheets`, `lineReservedByMaterial`, `onSelect/onReserve/onUnreserve` are identical across the component type (Task 4 Step 3), `RowTable` (Step 4), the call site (Step 5), and the drawer (Task 5 Step 4). API body fields (`action`, `materialId`, `requiredSheets`, `targetReserveQty`, `releaseQty`, `prImpactAction`) match `reservation-control` POST. `getPlanningReservedByMaterial(planningId)` single-arg call matches the optional-`materialIds` signature.
- **No placeholders:** every code step contains full code; every run step has an exact command + expected result.
