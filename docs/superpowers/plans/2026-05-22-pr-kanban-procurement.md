# PR Kanban Procurement Enhancement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make PR Kanban draft cards editable with revision history, auto-consolidate PRs in the Ordered column, generate real vendor POs from explicit single/bulk selection (no popup on move), show GRN-synced monitoring cards, and make cards ~40-50% more compact.

**Architecture:** Additive Prisma schema changes (new PR fields, a many-PRs→one-PO join table, PO terms). A pure consolidation lib drives both UI grouping and server-side PO generation. New/extended API routes handle draft edits (with per-field audit), a new `ordered` status, and bulk PO generation. The 567-line board page is decomposed into focused components (card, edit drawer, generate-PO dialog).

**Tech Stack:** Next.js App Router (route handlers), Prisma, React Query (`@tanstack/react-query`), Zod, Vitest, Tailwind with `ds-*` design tokens, existing `SlideOverPanel` / `PageHeader` components, `createAuditLog` helper.

**Spec:** `docs/superpowers/specs/2026-05-22-pr-kanban-procurement-design.md`

---

## File Structure

**Create:**
- `src/lib/pr-consolidation.ts` — pure consolidation engine (grouping by material|board|gsm|size).
- `src/lib/pr-consolidation.test.ts` — Vitest unit tests for the engine.
- `src/lib/purchase-requisition-status.test.ts` — Vitest tests for the status mapping (incl. new `ordered`).
- `src/app/api/purchase-requisitions/generate-po/route.ts` — bulk PO generation endpoint.
- `src/components/inventory/PrCard.tsx` — compact card + ordered monitoring card.
- `src/components/inventory/PrEditDrawer.tsx` — draft edit + revision history + reservation block.
- `src/components/inventory/GeneratePoDialog.tsx` — vendor/terms dialog for single/bulk PO creation.

**Modify:**
- `prisma/schema.prisma` — PR fields, `VendorPoRequisitionLink`, VMPO terms + relations.
- `src/lib/purchase-requisition-status.ts` — add `ordered` db status.
- `src/app/api/purchase-requisitions/[id]/route.ts` — add `PUT` (edit) and `GET` (detail+history).
- `src/app/api/purchase-requisitions/[id]/stage/route.ts` — `ordered` status, drop `qtyQuarantine` bump.
- `src/app/api/purchase-requisitions/route.ts` — extend GET payload (fields + PO monitoring).
- `src/app/(dashboard)/inventory/purchase-requisitions/page.tsx` — consolidation rendering, selection, wiring, compact cards.

---

## Task 1: Prisma schema — PR fields, PO link table, PO terms

**Files:**
- Modify: `prisma/schema.prisma` (PurchaseRequisition ~2020-2046, VendorMaterialPurchaseOrder ~1113-1163; add new model)

- [ ] **Step 1: Add fields to `PurchaseRequisition`**

In the `PurchaseRequisition` model, after the `gsm Int?` line, add:

```prisma
  remarks          String?   @map("remarks") @db.Text
  requiredByDate   DateTime? @map("required_by_date") @db.Date
```

And add this relation alongside `vendorPurchaseOrders`:

```prisma
  poLinks              VendorPoRequisitionLink[]
```

- [ ] **Step 2: Add terms fields + relation to `VendorMaterialPurchaseOrder`**

In `VendorMaterialPurchaseOrder`, after the `remarks String?` line add:

```prisma
  paymentTerms             String?   @map("payment_terms") @db.VarChar(200)
  transportTerms           String?   @map("transport_terms") @db.VarChar(200)
```

And in its relations block (next to `lines` / `receipts`) add:

```prisma
  requisitionLinks    VendorPoRequisitionLink[]
```

- [ ] **Step 3: Add the join model**

Add this new model near `PurchaseRequisition` (after the `MaterialReservation` model, before `MaterialShortage`):

```prisma
/// Many PRs → one consolidated vendor PO, with per-PR allocated quantity for traceability.
model VendorPoRequisitionLink {
  id                    String   @id @default(uuid())
  vendorPoId            String   @map("vendor_po_id")
  purchaseRequisitionId String   @map("purchase_requisition_id")
  allocatedQty          Decimal  @map("allocated_qty") @db.Decimal(12, 3)
  createdAt             DateTime @default(now()) @map("created_at")

  vendorPo VendorMaterialPurchaseOrder @relation(fields: [vendorPoId], references: [id], onDelete: Cascade)
  pr       PurchaseRequisition         @relation(fields: [purchaseRequisitionId], references: [id], onDelete: Cascade)

  @@unique([vendorPoId, purchaseRequisitionId])
  @@index([purchaseRequisitionId])
  @@map("vendor_po_requisition_links")
}
```

- [ ] **Step 4: Create the migration**

Run: `npx prisma migrate dev --name pr_procurement_phase1`
Expected: migration created under `prisma/migrations/`, applied cleanly, client regenerated.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no new errors).

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(pr): schema for editable PRs, many-PR->one-PO link, PO terms"
```

---

## Task 2: Status lib — add `ordered` db status (TDD)

**Files:**
- Test: `src/lib/purchase-requisition-status.test.ts` (create)
- Modify: `src/lib/purchase-requisition-status.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/purchase-requisition-status.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import {
  dbStatusToUiStage,
  uiStageToDbStatus,
  mapFilterToDbStatuses,
} from './purchase-requisition-status'

describe('purchase-requisition-status', () => {
  it('maps the new ordered db status to the ordered UI stage', () => {
    expect(dbStatusToUiStage('ordered')).toBe('ordered')
  })

  it('still maps converted_to_po to the ordered UI stage', () => {
    expect(dbStatusToUiStage('converted_to_po')).toBe('ordered')
  })

  it('maps received and approved correctly', () => {
    expect(dbStatusToUiStage('received')).toBe('received')
    expect(dbStatusToUiStage('approved')).toBe('approved')
    expect(dbStatusToUiStage('pending')).toBe('draft')
    expect(dbStatusToUiStage(null)).toBe('draft')
  })

  it('converts the ordered UI stage to the awaiting-PO ordered db status', () => {
    expect(uiStageToDbStatus('ordered')).toBe('ordered')
    expect(uiStageToDbStatus('approved')).toBe('approved')
    expect(uiStageToDbStatus('received')).toBe('received')
    expect(uiStageToDbStatus('draft')).toBe('pending')
  })

  it('filter for ordered includes both ordered and converted_to_po', () => {
    expect(mapFilterToDbStatuses('ordered')).toEqual(['ordered', 'converted_to_po'])
    expect(mapFilterToDbStatuses('converted_to_po')).toEqual(['ordered', 'converted_to_po'])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/purchase-requisition-status.test.ts`
Expected: FAIL — `uiStageToDbStatus('ordered')` returns `'converted_to_po'`, and the filter returns `['converted_to_po']`.

- [ ] **Step 3: Update the status lib**

Edit `src/lib/purchase-requisition-status.ts`:

Change the `PrDbStatus` type to include `'ordered'`:

```typescript
export type PrDbStatus = 'pending' | 'approved' | 'ordered' | 'converted_to_po' | 'received' | 'rejected'
```

In `dbStatusToUiStage`, add the `ordered` case before the `converted_to_po` check:

```typescript
export function dbStatusToUiStage(status: string | null | undefined): PrUiStage {
  if (status === 'approved') return 'approved'
  if (status === 'ordered') return 'ordered'
  if (status === 'converted_to_po') return 'ordered'
  if (status === 'received') return 'received'
  return 'draft'
}
```

In `uiStageToDbStatus`, return the awaiting-PO `ordered` value:

```typescript
export function uiStageToDbStatus(stage: PrUiStage): PrDbStatus {
  if (stage === 'approved') return 'approved'
  if (stage === 'ordered') return 'ordered'
  if (stage === 'received') return 'received'
  return 'pending'
}
```

In `mapFilterToDbStatuses`, return both statuses for the ordered filter:

```typescript
  if (val === 'ordered' || val === 'converted_to_po') return ['ordered', 'converted_to_po']
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/purchase-requisition-status.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/purchase-requisition-status.ts src/lib/purchase-requisition-status.test.ts
git commit -m "feat(pr): add awaiting-PO 'ordered' status to status mapping"
```

---

## Task 3: Consolidation engine (TDD)

**Files:**
- Create: `src/lib/pr-consolidation.ts`
- Test: `src/lib/pr-consolidation.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/pr-consolidation.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { consolidatePrs, type ConsolidatablePr } from './pr-consolidation'

const base: Omit<ConsolidatablePr, 'id' | 'qty'> = {
  materialId: 'mat-duplex',
  materialCode: 'DPX-230',
  boardType: 'Duplex',
  gsm: 230,
  sizeLabel: '20x30',
  supplierId: 'sup-a',
  requiredByDate: '2026-05-24',
}

describe('consolidatePrs', () => {
  it('merges PRs that share material|board|gsm|size into one group with summed qty', () => {
    const groups = consolidatePrs([
      { ...base, id: 'pr1', qty: 10000 },
      { ...base, id: 'pr2', qty: 8000 },
      { ...base, id: 'pr3', qty: 12000 },
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.totalQty).toBe(30000)
    expect(groups[0]!.members.map((m) => m.prId).sort()).toEqual(['pr1', 'pr2', 'pr3'])
  })

  it('merges across different vendors and suggests the most common supplier', () => {
    const groups = consolidatePrs([
      { ...base, id: 'pr1', qty: 10000, supplierId: 'sup-a' },
      { ...base, id: 'pr2', qty: 8000, supplierId: 'sup-b' },
      { ...base, id: 'pr3', qty: 12000, supplierId: 'sup-a' },
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.suggestedSupplierId).toBe('sup-a')
  })

  it('separates PRs that differ on any grouping field', () => {
    const groups = consolidatePrs([
      { ...base, id: 'pr1', qty: 10000, gsm: 230 },
      { ...base, id: 'pr2', qty: 8000, gsm: 300 },
      { ...base, id: 'pr3', qty: 5000, boardType: 'SBS' },
    ])
    expect(groups).toHaveLength(3)
  })

  it('picks the earliest required date for the group', () => {
    const groups = consolidatePrs([
      { ...base, id: 'pr1', qty: 1, requiredByDate: '2026-06-01' },
      { ...base, id: 'pr2', qty: 1, requiredByDate: '2026-05-20' },
    ])
    expect(groups[0]!.earliestRequiredDate).toBe('2026-05-20')
  })

  it('handles a single PR and a null supplier/date gracefully', () => {
    const groups = consolidatePrs([
      { ...base, id: 'pr1', qty: 500, supplierId: null, requiredByDate: null },
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.totalQty).toBe(500)
    expect(groups[0]!.suggestedSupplierId).toBeNull()
    expect(groups[0]!.earliestRequiredDate).toBeNull()
  })

  it('returns an empty array for empty input', () => {
    expect(consolidatePrs([])).toEqual([])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/pr-consolidation.test.ts`
Expected: FAIL — `Cannot find module './pr-consolidation'`.

- [ ] **Step 3: Implement the engine**

Create `src/lib/pr-consolidation.ts`:

```typescript
export type ConsolidatablePr = {
  id: string
  materialId: string
  materialCode: string
  boardType: string | null
  gsm: number | null
  sizeLabel: string | null
  qty: number
  supplierId: string | null
  requiredByDate: string | null
}

export type ConsolidatedGroupMember = {
  prId: string
  qty: number
  supplierId: string | null
  requiredByDate: string | null
}

export type ConsolidatedGroup = {
  key: string
  materialId: string
  materialCode: string
  boardType: string | null
  gsm: number | null
  sizeLabel: string | null
  totalQty: number
  members: ConsolidatedGroupMember[]
  suggestedSupplierId: string | null
  earliestRequiredDate: string | null
}

export function consolidationKey(pr: {
  materialId: string
  boardType: string | null
  gsm: number | null
  sizeLabel: string | null
}): string {
  return [pr.materialId, pr.boardType ?? '', pr.gsm ?? '', pr.sizeLabel ?? ''].join('|')
}

function mostCommonSupplier(members: ConsolidatedGroupMember[]): string | null {
  const counts = new Map<string, number>()
  for (const m of members) {
    if (!m.supplierId) continue
    counts.set(m.supplierId, (counts.get(m.supplierId) ?? 0) + 1)
  }
  let best: string | null = null
  let bestCount = 0
  for (const [supplierId, count] of counts) {
    if (count > bestCount) {
      best = supplierId
      bestCount = count
    }
  }
  return best
}

function earliestDate(members: ConsolidatedGroupMember[]): string | null {
  const dates = members.map((m) => m.requiredByDate).filter((d): d is string => !!d)
  if (dates.length === 0) return null
  return dates.reduce((a, b) => (new Date(a).getTime() <= new Date(b).getTime() ? a : b))
}

export function consolidatePrs(prs: ConsolidatablePr[]): ConsolidatedGroup[] {
  const byKey = new Map<string, ConsolidatedGroup>()

  for (const pr of prs) {
    const key = consolidationKey(pr)
    let group = byKey.get(key)
    if (!group) {
      group = {
        key,
        materialId: pr.materialId,
        materialCode: pr.materialCode,
        boardType: pr.boardType,
        gsm: pr.gsm,
        sizeLabel: pr.sizeLabel,
        totalQty: 0,
        members: [],
        suggestedSupplierId: null,
        earliestRequiredDate: null,
      }
      byKey.set(key, group)
    }
    group.totalQty += pr.qty
    group.members.push({
      prId: pr.id,
      qty: pr.qty,
      supplierId: pr.supplierId,
      requiredByDate: pr.requiredByDate,
    })
  }

  const groups = Array.from(byKey.values())
  for (const group of groups) {
    group.suggestedSupplierId = mostCommonSupplier(group.members)
    group.earliestRequiredDate = earliestDate(group.members)
  }
  return groups
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/pr-consolidation.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/pr-consolidation.ts src/lib/pr-consolidation.test.ts
git commit -m "feat(pr): consolidation engine grouping PRs by material/board/gsm/size"
```

---

## Task 4: Edit + detail API on `[id]` route

**Files:**
- Modify: `src/app/api/purchase-requisitions/[id]/route.ts` (currently only DELETE)

- [ ] **Step 1: Add a `PUT` (edit draft) handler**

Add this handler to `src/app/api/purchase-requisitions/[id]/route.ts` (keep the existing imports `requireRole`, `db`, `createAuditLog`; add `NextRequest` is already imported). Add `import { z } from 'zod'` at the top.

```typescript
const editSchema = z.object({
  materialId: z.string().uuid().optional(),
  boardType: z.string().max(120).nullable().optional(),
  gsm: z.number().int().positive().nullable().optional(),
  sizeLabel: z.string().max(80).nullable().optional(),
  qtyRequired: z.number().positive().optional(),
  requiredByDate: z.string().datetime().nullable().optional(),
  supplierId: z.string().uuid().nullable().optional(),
  remarks: z.string().max(2000).nullable().optional(),
})

export async function PUT(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { error, user } = await requireRole('stores', 'production_manager', 'operations_head', 'md')
  if (error) return error

  const { id } = await context.params
  const parsed = editSchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 })
  }

  const pr = await db.purchaseRequisition.findUnique({ where: { id } })
  if (!pr) return NextResponse.json({ error: 'PR not found' }, { status: 404 })
  if (pr.status !== 'pending') {
    return NextResponse.json({ error: 'Only draft (pending) PRs can be edited' }, { status: 400 })
  }

  if (parsed.data.materialId) {
    const inv = await db.inventory.findUnique({ where: { id: parsed.data.materialId } })
    if (!inv) return NextResponse.json({ error: 'Material not found' }, { status: 404 })
  }

  const data = parsed.data
  const updateData: Record<string, unknown> = {}
  const changedFields: Array<{ field: string; oldValue: unknown; newValue: unknown }> = []

  const track = (field: string, oldVal: unknown, newVal: unknown, key: string) => {
    if (newVal === undefined) return
    if (String(oldVal ?? '') === String(newVal ?? '')) return
    updateData[key] = newVal
    changedFields.push({ field, oldValue: oldVal ?? null, newValue: newVal ?? null })
  }

  track('Material', pr.materialId, data.materialId, 'materialId')
  track('Board Type', pr.boardType, data.boardType, 'boardType')
  track('GSM', pr.gsm, data.gsm, 'gsm')
  track('Sheet Size', pr.sizeLabel, data.sizeLabel, 'sizeLabel')
  track('Required Qty', Number(pr.qtyRequired), data.qtyRequired, 'qtyRequired')
  track('Required Date', pr.requiredByDate?.toISOString() ?? null, data.requiredByDate ?? null, 'requiredByDate')
  track('Vendor', pr.supplierId, data.supplierId, 'supplierId')
  track('Remarks', pr.remarks, data.remarks, 'remarks')

  if (changedFields.length === 0) {
    return NextResponse.json({ success: true, unchanged: true })
  }

  if (updateData.requiredByDate) updateData.requiredByDate = new Date(updateData.requiredByDate as string)

  const updated = await db.purchaseRequisition.update({ where: { id }, data: updateData })

  for (const c of changedFields) {
    await createAuditLog({
      userId: user!.id,
      action: 'UPDATE',
      tableName: 'purchase_requisitions',
      recordId: id,
      oldValue: { field: c.field, value: c.oldValue },
      newValue: { field: c.field, value: c.newValue },
    })
  }

  return NextResponse.json({ success: true, id: updated.id, changed: changedFields.map((c) => c.field) })
}
```

- [ ] **Step 2: Add a `GET` (detail + revision history) handler**

Add to the same file:

```typescript
export async function GET(_req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { error } = await requireRole('stores', 'production_manager', 'operations_head', 'md')
  if (error) return error

  const { id } = await context.params
  const pr = await db.purchaseRequisition.findUnique({
    where: { id },
    include: { material: { select: { materialCode: true, description: true, unit: true } } },
  })
  if (!pr) return NextResponse.json({ error: 'PR not found' }, { status: 404 })

  const audits = await db.auditLog.findMany({
    where: { tableName: 'purchase_requisitions', recordId: id, action: 'UPDATE' },
    orderBy: { timestamp: 'asc' },
    select: { timestamp: true, userId: true, oldValue: true, newValue: true },
  })

  const revisions = audits
    .map((a, idx) => {
      const nv = (a.newValue as Record<string, unknown> | null) || {}
      const ov = (a.oldValue as Record<string, unknown> | null) || {}
      if (typeof nv.field !== 'string') return null
      return {
        revision: idx + 1,
        at: a.timestamp.toISOString(),
        userId: a.userId ?? null,
        field: nv.field as string,
        oldValue: ov.value ?? null,
        newValue: nv.value ?? null,
      }
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)

  // Section 6 — reservation visibility: linked shortages + job cards behind this PR.
  const shortages = await db.materialShortage.findMany({
    where: { purchaseReqId: id },
    select: { jobCardId: true, requiredByDate: true, remainingQty: true, shortageQty: true },
  })
  const jobIds = Array.from(new Set(shortages.map((s) => s.jobCardId).filter((v): v is string => !!v)))
  const jobCards = jobIds.length
    ? await db.productionJobCard.findMany({ where: { id: { in: jobIds } }, select: { id: true, jobCardNumber: true } })
    : []
  const jobMap = new Map(jobCards.map((j) => [j.id, j]))
  const reservations = shortages.map((s) => ({
    jobCardId: s.jobCardId ?? null,
    jobCardNumber: s.jobCardId ? (jobMap.get(s.jobCardId)?.jobCardNumber ?? null) : null,
    requiredByDate: s.requiredByDate ? s.requiredByDate.toISOString() : null,
    requiredQty: Number(s.shortageQty),
    pendingShortage: Number(s.remainingQty),
  }))
  const requiredQty = Number(pr.qtyRequired)
  const purchaseRequired = reservations.reduce((sum, r) => sum + r.pendingShortage, 0)
  const reservedQty = Math.max(0, requiredQty - purchaseRequired)

  return NextResponse.json({
    id: pr.id,
    status: pr.status,
    materialId: pr.materialId,
    material: pr.material,
    boardType: pr.boardType,
    gsm: pr.gsm,
    sizeLabel: pr.sizeLabel,
    qtyRequired: requiredQty,
    requiredByDate: pr.requiredByDate?.toISOString() ?? null,
    expectedDelivery: pr.expectedDelivery?.toISOString() ?? null,
    supplierId: pr.supplierId,
    remarks: pr.remarks,
    reservation: { requiredQty, reservedQty, purchaseRequired, links: reservations },
    revisions,
  })
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/purchase-requisitions/\[id\]/route.ts
git commit -m "feat(pr): PUT edit (per-field audit) + GET detail with revision history"
```

---

## Task 5: Adjust the stage route (ordered status, no stock bump)

**Files:**
- Modify: `src/app/api/purchase-requisitions/[id]/stage/route.ts`

- [ ] **Step 1: Stop mutating `qtyQuarantine` on move**

In `src/app/api/purchase-requisitions/[id]/stage/route.ts`, replace the entire `db.$transaction` block (currently lines ~32-63, the `update` plus the `qtyQuarantine` adjustment) with a plain update (no stock mutation — incoming now derives from real POs):

```typescript
  const updated = await db.purchaseRequisition.update({
    where: { id },
    data: {
      status,
      ...(parsed.data.poReference !== undefined ? { poReference: parsed.data.poReference || null } : {}),
      ...(expectedDelivery ? { expectedDelivery } : {}),
      ...(parsed.data.stage === 'approved' ? { approvedBy: user!.id, approvedAt: new Date() } : {}),
    },
  })
```

Because `uiStageToDbStatus('ordered')` now returns `'ordered'`, moving Approved→Ordered sets status `ordered` with no PO and no stock change. The `poReference` body field is now optional and unused by the board (Task 11 stops sending the fake `AUTO-...` reference).

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (the `inv`/`qty`/`prevOrdered` locals are removed).

- [ ] **Step 3: Commit**

```bash
git add src/app/api/purchase-requisitions/\[id\]/stage/route.ts
git commit -m "fix(pr): ordered move no longer fakes incoming stock (qtyQuarantine)"
```

---

## Task 6: Bulk PO generation endpoint

**Files:**
- Create: `src/app/api/purchase-requisitions/generate-po/route.ts`

- [ ] **Step 1: Implement the endpoint**

Create `src/app/api/purchase-requisitions/generate-po/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { db } from '@/lib/db'
import { z } from 'zod'
import { createAuditLog } from '@/lib/audit'
import { consolidatePrs, type ConsolidatablePr } from '@/lib/pr-consolidation'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  prIds: z.array(z.string().uuid()).min(1),
  vendorId: z.string().uuid(),
  deliveryDate: z.string().datetime().optional(),
  paymentTerms: z.string().max(200).optional(),
  transportTerms: z.string().max(200).optional(),
  remarks: z.string().max(2000).optional(),
})

export async function POST(req: NextRequest) {
  const { error, user } = await requireRole('stores', 'production_manager', 'operations_head', 'md')
  if (error) return error

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 })
  }
  const { prIds, vendorId, deliveryDate, paymentTerms, transportTerms, remarks } = parsed.data

  const prs = await db.purchaseRequisition.findMany({
    where: { id: { in: prIds } },
    include: { material: { select: { materialCode: true } } },
  })
  if (prs.length !== prIds.length) {
    return NextResponse.json({ error: 'One or more PRs not found' }, { status: 404 })
  }
  const notOrderable = prs.filter((p) => p.status !== 'approved' && p.status !== 'ordered')
  if (notOrderable.length > 0) {
    return NextResponse.json(
      { error: `PRs must be Approved or Ordered (awaiting PO) to generate a PO: ${notOrderable.map((p) => p.id).join(', ')}` },
      { status: 400 },
    )
  }
  const missingSpec = prs.filter((p) => !p.boardType || p.gsm == null)
  if (missingSpec.length > 0) {
    return NextResponse.json(
      { error: `PRs missing boardType/gsm cannot be ordered: ${missingSpec.map((p) => p.material.materialCode).join(', ')}` },
      { status: 400 },
    )
  }

  const consolidatable: ConsolidatablePr[] = prs.map((p) => ({
    id: p.id,
    materialId: p.materialId,
    materialCode: p.material.materialCode,
    boardType: p.boardType,
    gsm: p.gsm,
    sizeLabel: p.sizeLabel,
    qty: Number(p.qtyRequired),
    supplierId: p.supplierId,
    requiredByDate: p.requiredByDate?.toISOString() ?? null,
  }))
  const groups = consolidatePrs(consolidatable)

  const result = await db.$transaction(async (tx) => {
    const now = new Date()
    const yyyymmdd =
      `${now.getFullYear()}` +
      `${String(now.getMonth() + 1).padStart(2, '0')}` +
      `${String(now.getDate()).padStart(2, '0')}`
    const prefix = `PO-${yyyymmdd}-`
    const sameDayCount = await tx.vendorMaterialPurchaseOrder.count({ where: { poNumber: { startsWith: prefix } } })
    const poNumber = `${prefix}${String(sameDayCount + 1).padStart(3, '0')}`

    const po = await tx.vendorMaterialPurchaseOrder.create({
      data: {
        poNumber,
        supplierId: vendorId,
        purchaseRequisitionId: prs[0]!.id,
        requiredDeliveryDate: deliveryDate ? new Date(deliveryDate) : undefined,
        paymentTerms: paymentTerms ?? undefined,
        transportTerms: transportTerms ?? undefined,
        remarks: remarks ?? undefined,
        createdBy: user!.id,
        lines: {
          create: groups.map((g) => ({
            boardGrade: g.boardType ?? 'Unknown',
            gsm: g.gsm ?? 0,
            totalSheets: 0,
            totalWeightKg: g.totalQty,
            linkedPoLineIds: [],
          })),
        },
      },
    })

    for (const g of groups) {
      for (const m of g.members) {
        await tx.vendorPoRequisitionLink.create({
          data: { vendorPoId: po.id, purchaseRequisitionId: m.prId, allocatedQty: m.qty },
        })
      }
    }

    await tx.purchaseRequisition.updateMany({
      where: { id: { in: prIds } },
      data: {
        status: 'converted_to_po',
        poReference: po.id,
        supplierId: vendorId,
        ...(deliveryDate ? { expectedDelivery: new Date(deliveryDate) } : {}),
      },
    })

    return po
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'purchase_requisitions',
    recordId: prIds.join(','),
    oldValue: { status: 'approved_or_ordered', prIds },
    newValue: { status: 'converted_to_po', vendorPoId: result.id, poNumber: result.poNumber },
  })

  return NextResponse.json({
    success: true,
    purchaseOrderId: result.id,
    poNumber: result.poNumber,
    lineCount: groups.length,
    linkedPrCount: prIds.length,
  })
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Run the full unit suite (consolidation must still pass)**

Run: `npm test`
Expected: PASS (no regressions).

- [ ] **Step 4: Commit**

```bash
git add src/app/api/purchase-requisitions/generate-po/route.ts
git commit -m "feat(pr): bulk generate-po endpoint (consolidated lines, PR links)"
```

---

## Task 7: Extend the list GET payload

**Files:**
- Modify: `src/app/api/purchase-requisitions/route.ts` (GET handler)

- [ ] **Step 1: Return new PR fields and PO monitoring data**

In `src/app/api/purchase-requisitions/route.ts`, in the `GET` handler:

(a) After the `list` query, fetch linked POs for ordered PRs. Add after the `audits` block (~line 73):

```typescript
  const poRefs = Array.from(
    new Set(list.filter((r) => r.status === 'converted_to_po' && r.poReference).map((r) => r.poReference as string)),
  )
  const pos = poRefs.length
    ? await db.vendorMaterialPurchaseOrder.findMany({
        where: { id: { in: poRefs } },
        select: {
          id: true,
          poNumber: true,
          status: true,
          requiredDeliveryDate: true,
          totalReceivedKg: true,
          supplier: { select: { name: true } },
          lines: { select: { totalWeightKg: true } },
        },
      })
    : []
  const poById = new Map(pos.map((p) => [p.id, p]))
```

(b) Replace the final `return NextResponse.json(list.map((r) => ({ ... })))` mapping so each row also includes the new fields and a `monitoring` object:

```typescript
  return NextResponse.json(
    list.map((r) => {
      const po = r.status === 'converted_to_po' && r.poReference ? poById.get(r.poReference) : undefined
      const orderedQty = po ? po.lines.reduce((s, l) => s + Number(l.totalWeightKg), 0) : null
      const receivedQty = po ? Number(po.totalReceivedKg) : null
      return {
        linkedShortages: shortages
          .filter((s) => s.purchaseReqId === r.id)
          .map((s) => ({
            jobCardId: s.jobCardId ?? null,
            jobCardNumber: s.jobCardId ? (jobMap.get(s.jobCardId)?.jobCardNumber ?? null) : null,
            planningId: s.planningId,
            requiredByDate: s.requiredByDate ? s.requiredByDate.toISOString() : null,
            pendingShortage: Number(s.remainingQty),
            requiredQty: Number(s.shortageQty),
          })),
        ...r,
        boardType: r.boardType,
        gsm: r.gsm,
        sizeLabel: r.sizeLabel,
        requiredByDate: r.requiredByDate ? r.requiredByDate.toISOString() : null,
        remarks: r.remarks,
        supplierId: r.supplierId,
        uiStage: dbStatusToUiStage(r.status),
        monitoring: po
          ? {
              poNumber: po.poNumber,
              vendorName: po.supplier?.name ?? null,
              status: po.status,
              eta: po.requiredDeliveryDate ? po.requiredDeliveryDate.toISOString() : null,
              orderedQty,
              receivedQty,
              pendingQty: orderedQty != null && receivedQty != null ? Math.max(0, orderedQty - receivedQty) : null,
            }
          : null,
        orderedAt:
          orderedAtById.get(r.id) ??
          (r.status === 'converted_to_po' || r.status === 'received' || r.status === 'ordered'
            ? (r.approvedAt ?? r.createdAt).toISOString()
            : null),
        receivedAt:
          receivedAtById.get(r.id) ??
          (r.status === 'received' ? (r.approvedAt ?? r.createdAt).toISOString() : null),
      }
    }),
  )
```

Note: the `material` select on the list query already returns `materialCode`/`description`/`unit`; `r.boardType`/`r.gsm`/`r.sizeLabel`/`r.requiredByDate`/`r.remarks` are now scalar columns on the PR row from Task 1, so no `include` change is needed.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/purchase-requisitions/route.ts
git commit -m "feat(pr): list payload exposes spec fields + PO monitoring numbers"
```

---

## Task 8: Compact card component

**Files:**
- Create: `src/components/inventory/PrCard.tsx`

- [ ] **Step 1: Define the shared PR type and compact card**

Create `src/components/inventory/PrCard.tsx`:

```tsx
'use client'

export type PrRow = {
  id: string
  materialId: string
  qtyRequired: number
  status: string
  triggerReason: string
  poReference: string | null
  raisedBy: string | null
  boardType: string | null
  gsm: number | null
  sizeLabel: string | null
  requiredByDate: string | null
  remarks: string | null
  supplierId: string | null
  sourceJobCardId?: string | null
  sourcePlanningId?: string | null
  material: { materialCode: string; description: string; unit: string }
  linkedShortages?: Array<{
    jobCardId: string | null
    jobCardNumber: number | null
    requiredByDate: string | null
    pendingShortage: number
    requiredQty: number
  }>
  monitoring?: {
    poNumber: string
    vendorName: string | null
    status: string
    eta: string | null
    orderedQty: number | null
    receivedQty: number | null
    pendingQty: number | null
  } | null
}

function reservationTotals(pr: PrRow) {
  const linked = pr.linkedShortages ?? []
  const required = Number(pr.qtyRequired)
  const purchaseReq = linked.reduce((s, l) => s + Number(l.pendingShortage), 0)
  const reserved = Math.max(0, required - purchaseReq)
  const jobs = new Set(linked.map((l) => l.jobCardId).filter(Boolean) as string[])
  if (pr.sourceJobCardId) jobs.add(pr.sourceJobCardId)
  return { required, reserved, purchaseReq, jobCount: jobs.size }
}

export function PrCompactCard({
  pr,
  selectable,
  selected,
  onToggleSelect,
  onOpen,
}: {
  pr: PrRow
  selectable?: boolean
  selected?: boolean
  onToggleSelect?: () => void
  onOpen: () => void
}) {
  const t = reservationTotals(pr)
  const urgent = (pr.linkedShortages?.length ?? 0) > 0 && pr.status === 'pending'
  return (
    <div className="rounded-ds-md border border-ds-line/40 bg-background px-2 py-1.5 text-xs">
      <div className="flex items-center gap-2">
        {selectable ? (
          <input
            type="checkbox"
            checked={!!selected}
            onChange={onToggleSelect}
            onClick={(e) => e.stopPropagation()}
            className="h-3.5 w-3.5 shrink-0"
          />
        ) : null}
        <button type="button" onClick={onOpen} className="flex-1 text-left">
          <span className="font-semibold text-ds-ink">{pr.material.materialCode}</span>
          {pr.boardType ? <span className="text-ds-ink-muted"> · {pr.boardType}</span> : null}
          {pr.raisedBy === null ? <span className="ml-1 text-[10px] text-ds-warning">⚡</span> : null}
          <span className={`ml-1 inline-block h-1.5 w-1.5 rounded-full ${urgent ? 'bg-[var(--error)]' : 'bg-[var(--warning)]'}`} />
        </button>
      </div>
      <button type="button" onClick={onOpen} className="mt-1 block w-full text-left text-[11px] text-ds-ink-faint">
        <span>Qty {t.required.toLocaleString('en-IN')}</span>
        <span> · Rsv {t.reserved.toLocaleString('en-IN')}</span>
        <span> · Buy {t.purchaseReq.toLocaleString('en-IN')}</span>
        {pr.requiredByDate ? <span> · {new Date(pr.requiredByDate).toLocaleDateString('en-IN')}</span> : null}
        {t.jobCount > 0 ? <span> · 🔗{t.jobCount}</span> : null}
      </button>
    </div>
  )
}
```

- [ ] **Step 2: Add the consolidated ordered card (with monitoring)**

Append to the same file:

```tsx
export function OrderedConsolidatedCard({
  materialCode,
  boardType,
  gsm,
  sizeLabel,
  totalQty,
  memberCount,
  monitoring,
  selectable,
  selected,
  onToggleSelect,
  onOpen,
}: {
  materialCode: string
  boardType: string | null
  gsm: number | null
  sizeLabel: string | null
  totalQty: number
  memberCount: number
  monitoring: PrRow['monitoring']
  selectable: boolean
  selected: boolean
  onToggleSelect: () => void
  onOpen: () => void
}) {
  return (
    <div className="rounded-ds-md border border-ds-line/40 bg-background px-2 py-1.5 text-xs">
      <div className="flex items-center gap-2">
        {monitoring ? null : (
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelect}
            onClick={(e) => e.stopPropagation()}
            className="h-3.5 w-3.5 shrink-0"
            disabled={!selectable}
          />
        )}
        <button type="button" onClick={onOpen} className="flex-1 text-left">
          <span className="font-semibold text-ds-ink">{materialCode}</span>
          {boardType ? <span className="text-ds-ink-muted"> · {boardType}</span> : null}
          {gsm ? <span className="text-ds-ink-muted"> · {gsm}g</span> : null}
          {sizeLabel ? <span className="text-ds-ink-muted"> · {sizeLabel}</span> : null}
        </button>
      </div>
      {monitoring ? (
        <button type="button" onClick={onOpen} className="mt-1 block w-full text-left text-[11px] text-ds-ink-faint">
          <span className="font-semibold text-ds-ink">{monitoring.poNumber}</span>
          {monitoring.vendorName ? <span> · {monitoring.vendorName}</span> : null}
          <br />
          <span>Ord {Number(monitoring.orderedQty ?? totalQty).toLocaleString('en-IN')}</span>
          <span> · Rcv {Number(monitoring.receivedQty ?? 0).toLocaleString('en-IN')}</span>
          <span> · Bal {Number(monitoring.pendingQty ?? 0).toLocaleString('en-IN')}</span>
          {monitoring.eta ? <span> · ETA {new Date(monitoring.eta).toLocaleDateString('en-IN')}</span> : null}
        </button>
      ) : (
        <button type="button" onClick={onOpen} className="mt-1 block w-full text-left text-[11px] text-ds-ink-faint">
          <span>Total {totalQty.toLocaleString('en-IN')}</span>
          <span> · {memberCount} PR{memberCount === 1 ? '' : 's'}</span>
          <span className="ml-1 rounded bg-ds-warning/15 px-1 text-ds-warning">Awaiting PO</span>
        </button>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/inventory/PrCard.tsx
git commit -m "feat(pr): compact PR card + consolidated/monitoring ordered card"
```

---

## Task 9: Draft edit drawer component

**Files:**
- Create: `src/components/inventory/PrEditDrawer.tsx`

- [ ] **Step 1: Implement the drawer**

Create `src/components/inventory/PrEditDrawer.tsx`:

```tsx
'use client'

import { useEffect, useState } from 'react'
import { SlideOverPanel } from '@/components/ui/SlideOverPanel'
import type { PrRow } from './PrCard'

type Detail = {
  id: string
  status: string
  materialId: string
  material: { materialCode: string; description: string; unit: string }
  boardType: string | null
  gsm: number | null
  sizeLabel: string | null
  qtyRequired: number
  requiredByDate: string | null
  supplierId: string | null
  remarks: string | null
  reservation: {
    requiredQty: number
    reservedQty: number
    purchaseRequired: number
    links: Array<{ jobCardId: string | null; jobCardNumber: number | null; requiredByDate: string | null; requiredQty: number; pendingShortage: number }>
  }
  revisions: Array<{ revision: number; at: string; userId: string | null; field: string; oldValue: unknown; newValue: unknown }>
}

export function PrEditDrawer({
  prId,
  open,
  onClose,
  onSaved,
}: {
  prId: string | null
  open: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const [detail, setDetail] = useState<Detail | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({ boardType: '', gsm: '', sizeLabel: '', qtyRequired: '', requiredByDate: '', remarks: '' })

  useEffect(() => {
    if (!open || !prId) return
    setLoading(true)
    setDetail(null)
    fetch(`/api/purchase-requisitions/${prId}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d: Detail) => {
        setDetail(d)
        setForm({
          boardType: d.boardType ?? '',
          gsm: d.gsm != null ? String(d.gsm) : '',
          sizeLabel: d.sizeLabel ?? '',
          qtyRequired: String(d.qtyRequired ?? ''),
          requiredByDate: d.requiredByDate ? d.requiredByDate.slice(0, 10) : '',
          remarks: d.remarks ?? '',
        })
      })
      .catch(() => setDetail(null))
      .finally(() => setLoading(false))
  }, [open, prId])

  const isDraft = detail?.status === 'pending'

  async function save() {
    if (!prId) return
    setBusy(true)
    try {
      const res = await fetch(`/api/purchase-requisitions/${prId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          boardType: form.boardType || null,
          gsm: form.gsm ? Number(form.gsm) : null,
          sizeLabel: form.sizeLabel || null,
          qtyRequired: form.qtyRequired ? Number(form.qtyRequired) : undefined,
          requiredByDate: form.requiredByDate ? new Date(form.requiredByDate).toISOString() : null,
          remarks: form.remarks || null,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((data as { error?: string }).error || 'Save failed')
      onSaved()
      onClose()
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  async function approve() {
    if (!prId) return
    setBusy(true)
    try {
      const res = await fetch(`/api/purchase-requisitions/${prId}/approve`, { method: 'PUT' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((data as { error?: string }).error || 'Approve failed')
      onSaved()
      onClose()
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Approve failed')
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!prId || !window.confirm('Delete this PR?')) return
    setBusy(true)
    try {
      const res = await fetch(`/api/purchase-requisitions/${prId}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Delete failed')
      onSaved()
      onClose()
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Delete failed')
    } finally {
      setBusy(false)
    }
  }

  const field = 'w-full rounded-ds-md border border-ds-line/60 bg-ds-card px-2 py-1 text-sm'
  const label = 'text-[11px] uppercase tracking-wide text-ds-ink-muted'

  return (
    <SlideOverPanel
      title="Purchase Requisition"
      isOpen={open}
      onClose={onClose}
      widthClass="max-w-xl"
      panelClassName="border-l border-ds-line/40 bg-background shadow-2xl"
    >
      <div className="space-y-4 px-4 py-3">
        {loading || !detail ? (
          <p className="text-xs text-ds-ink-muted">Loading…</p>
        ) : (
          <>
            <section className="rounded border border-ds-line/40 p-3 text-xs">
              <p className="font-semibold text-ds-ink">{detail.material.materialCode}</p>
              <p className="text-ds-ink-faint">{detail.material.description}</p>
              <p className="mt-1 text-ds-ink-muted">Status: {detail.status}</p>
            </section>

            <section className="space-y-2">
              <div>
                <label className={label}>Board Type</label>
                <input className={field} disabled={!isDraft} value={form.boardType} onChange={(e) => setForm({ ...form, boardType: e.target.value })} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={label}>GSM</label>
                  <input type="number" className={field} disabled={!isDraft} value={form.gsm} onChange={(e) => setForm({ ...form, gsm: e.target.value })} />
                </div>
                <div>
                  <label className={label}>Sheet Size</label>
                  <input className={field} disabled={!isDraft} value={form.sizeLabel} onChange={(e) => setForm({ ...form, sizeLabel: e.target.value })} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={label}>Required Qty</label>
                  <input type="number" className={field} disabled={!isDraft} value={form.qtyRequired} onChange={(e) => setForm({ ...form, qtyRequired: e.target.value })} />
                </div>
                <div>
                  <label className={label}>Required Date</label>
                  <input type="date" className={field} disabled={!isDraft} value={form.requiredByDate} onChange={(e) => setForm({ ...form, requiredByDate: e.target.value })} />
                </div>
              </div>
              <div>
                <label className={label}>Procurement Remarks</label>
                <textarea className={field} rows={2} disabled={!isDraft} value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })} />
              </div>
            </section>

            {isDraft ? (
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={busy} onClick={() => void save()} className="rounded border border-ds-line/50 px-3 py-1.5 text-xs text-ds-ink hover:bg-ds-main/50 disabled:opacity-40">Save Draft</button>
                <button type="button" disabled={busy} onClick={() => void approve()} className="rounded border border-[var(--success)]/40 bg-[var(--success-bg)] px-3 py-1.5 text-xs text-[var(--success)] disabled:opacity-40">Approve</button>
                <button type="button" disabled={busy} onClick={() => void remove()} className="rounded border border-[var(--error)]/35 bg-[var(--error-bg)] px-3 py-1.5 text-xs text-[var(--error)] disabled:opacity-40">Delete</button>
              </div>
            ) : (
              <p className="text-[11px] text-ds-ink-faint">Fields locked — this PR is no longer a draft.</p>
            )}

            <section className="rounded border border-ds-line/40 p-3 text-xs">
              <p className="mb-1 font-semibold text-ds-ink">Reservation</p>
              <div className="mb-1 flex gap-3 text-ds-ink-muted">
                <span>Required <span className="text-ds-ink">{detail.reservation.requiredQty.toLocaleString('en-IN')}</span></span>
                <span>Reserved <span className="text-ds-ink">{detail.reservation.reservedQty.toLocaleString('en-IN')}</span></span>
                <span>Purchase req'd <span className="text-ds-ink">{detail.reservation.purchaseRequired.toLocaleString('en-IN')}</span></span>
              </div>
              {detail.reservation.links.length === 0 ? (
                <p className="text-ds-ink-faint">No linked job cards.</p>
              ) : (
                <ul className="space-y-1">
                  {detail.reservation.links.map((l, i) => (
                    <li key={i} className="rounded border border-ds-line/30 px-2 py-1 text-ds-ink-muted">
                      JC#{l.jobCardNumber ?? '—'} · Req {l.requiredQty.toLocaleString('en-IN')} · Short {l.pendingShortage.toLocaleString('en-IN')}
                      {l.requiredByDate ? ` · ${new Date(l.requiredByDate).toLocaleDateString('en-IN')}` : ''}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="rounded border border-ds-line/40 p-3 text-xs">
              <p className="mb-1 font-semibold text-ds-ink">Revision History</p>
              {detail.revisions.length === 0 ? (
                <p className="text-ds-ink-faint">No revisions yet.</p>
              ) : (
                <ul className="space-y-1">
                  {detail.revisions.map((r) => (
                    <li key={r.revision} className="rounded border border-ds-line/30 px-2 py-1 text-ds-ink-muted">
                      #{r.revision} · {new Date(r.at).toLocaleString('en-IN')} · <span className="text-ds-ink">{r.field}</span>: {String(r.oldValue ?? '—')} → {String(r.newValue ?? '—')}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </SlideOverPanel>
  )
}
```

Note: "Change material" picker is intentionally out of this first cut — `materialId` re-pointing is supported by the API (Task 4) and can be wired with the existing material picker in a follow-up; spec section 2 lists it but it is not required for the core editable-draft flow. (If required now, add a material search `<select>` bound to `materialId` and include it in the PUT body.)

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/inventory/PrEditDrawer.tsx
git commit -m "feat(pr): draft edit drawer with lock-after-approve + revision history"
```

---

## Task 10: Generate PO dialog component

**Files:**
- Create: `src/components/inventory/GeneratePoDialog.tsx`

- [ ] **Step 1: Implement the dialog**

Create `src/components/inventory/GeneratePoDialog.tsx`:

```tsx
'use client'

import { useEffect, useState } from 'react'
import { SlideOverPanel } from '@/components/ui/SlideOverPanel'

type Vendor = { id: string; name: string }

export type GeneratePoSelection = {
  prIds: string[]
  summary: Array<{ materialCode: string; boardType: string | null; gsm: number | null; sizeLabel: string | null; totalQty: number; prCount: number }>
  suggestedVendorId: string | null
}

export function GeneratePoDialog({
  open,
  selection,
  onClose,
  onCreated,
}: {
  open: boolean
  selection: GeneratePoSelection | null
  onClose: () => void
  onCreated: () => void
}) {
  const [vendors, setVendors] = useState<Vendor[]>([])
  const [vendorId, setVendorId] = useState('')
  const [deliveryDate, setDeliveryDate] = useState('')
  const [paymentTerms, setPaymentTerms] = useState('')
  const [transportTerms, setTransportTerms] = useState('')
  const [remarks, setRemarks] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    fetch('/api/masters/suppliers', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => setVendors(Array.isArray(d) ? d : (d.suppliers ?? [])))
      .catch(() => setVendors([]))
    setVendorId(selection?.suggestedVendorId ?? '')
    setDeliveryDate('')
    setPaymentTerms('')
    setTransportTerms('')
    setRemarks('')
  }, [open, selection])

  async function create() {
    if (!selection || !vendorId) {
      alert('Select a vendor')
      return
    }
    setBusy(true)
    try {
      const res = await fetch('/api/purchase-requisitions/generate-po', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prIds: selection.prIds,
          vendorId,
          deliveryDate: deliveryDate ? new Date(deliveryDate).toISOString() : undefined,
          paymentTerms: paymentTerms || undefined,
          transportTerms: transportTerms || undefined,
          remarks: remarks || undefined,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((data as { error?: string }).error || 'PO creation failed')
      onCreated()
      onClose()
    } catch (e) {
      alert(e instanceof Error ? e.message : 'PO creation failed')
    } finally {
      setBusy(false)
    }
  }

  const field = 'w-full rounded-ds-md border border-ds-line/60 bg-ds-card px-2 py-1 text-sm'
  const label = 'text-[11px] uppercase tracking-wide text-ds-ink-muted'

  return (
    <SlideOverPanel
      title="Generate Purchase Order"
      isOpen={open}
      onClose={onClose}
      widthClass="max-w-xl"
      panelClassName="border-l border-ds-line/40 bg-background shadow-2xl"
    >
      <div className="space-y-4 px-4 py-3">
        <section className="rounded border border-ds-line/40 p-3 text-xs">
          <p className="mb-1 font-semibold text-ds-ink">Consolidation preview</p>
          {(selection?.summary ?? []).map((s, i) => (
            <div key={i} className="rounded border border-ds-line/30 px-2 py-1 text-ds-ink-muted">
              {s.materialCode} · {s.boardType ?? '—'} · {s.gsm ?? '—'}g · {s.sizeLabel ?? '—'} ·{' '}
              <span className="text-ds-ink">Total {s.totalQty.toLocaleString('en-IN')}</span> · {s.prCount} PR{s.prCount === 1 ? '' : 's'}
            </div>
          ))}
        </section>

        <div>
          <label className={label}>Vendor</label>
          <select className={field} value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
            <option value="">Select vendor…</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>{v.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={label}>Delivery Date</label>
          <input type="date" className={field} value={deliveryDate} onChange={(e) => setDeliveryDate(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={label}>Payment Terms</label>
            <input className={field} value={paymentTerms} onChange={(e) => setPaymentTerms(e.target.value)} />
          </div>
          <div>
            <label className={label}>Transport Terms</label>
            <input className={field} value={transportTerms} onChange={(e) => setTransportTerms(e.target.value)} />
          </div>
        </div>
        <div>
          <label className={label}>Remarks</label>
          <textarea className={field} rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
        </div>

        <button type="button" disabled={busy || !vendorId} onClick={() => void create()} className="rounded border border-[var(--success)]/40 bg-[var(--success-bg)] px-3 py-1.5 text-sm text-[var(--success)] disabled:opacity-40">
          {busy ? 'Creating…' : 'Generate PO'}
        </button>
      </div>
    </SlideOverPanel>
  )
}
```

- [ ] **Step 2: Verify the suppliers endpoint path**

Run: `ls src/app/api/masters/suppliers/route.ts 2>/dev/null || grep -rl "vendorMaterialPurchaseOrder\|supplier.findMany" src/app/api/masters 2>/dev/null | head`
Expected: confirms a suppliers list endpoint exists. If the path differs, update the `fetch('/api/masters/suppliers')` URL in the dialog accordingly. If none exists, create a minimal `GET` returning `db.supplier.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } })` at `src/app/api/masters/suppliers/route.ts` and commit it as part of this task.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/inventory/GeneratePoDialog.tsx
git commit -m "feat(pr): generate-PO dialog (vendor, terms, consolidation preview)"
```

---

## Task 11: Wire the board page

**Files:**
- Modify: `src/app/(dashboard)/inventory/purchase-requisitions/page.tsx`

- [ ] **Step 1: Swap imports and the row type**

At the top of the file, add imports and reuse `PrRow`:

```tsx
import { PrCompactCard, OrderedConsolidatedCard, type PrRow } from '@/components/inventory/PrCard'
import { PrEditDrawer } from '@/components/inventory/PrEditDrawer'
import { GeneratePoDialog, type GeneratePoSelection } from '@/components/inventory/GeneratePoDialog'
import { consolidatePrs } from '@/lib/pr-consolidation'
```

Replace the local `type PR = {...}` (lines ~9-29) with `type PR = PrRow`. Update the `useQuery<PR[]>` generic accordingly (it already is `PR[]`).

- [ ] **Step 2: Add drawer + dialog state and selection state for ordered cards**

Inside the component, alongside the existing `useState` hooks (~lines 92-98), add:

```tsx
  const [editPrId, setEditPrId] = useState<string | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [orderedSel, setOrderedSel] = useState<Set<string>>(new Set()) // PR ids of awaiting-PO ordered cards
  const [poDialogOpen, setPoDialogOpen] = useState(false)
  const [poSelection, setPoSelection] = useState<GeneratePoSelection | null>(null)
```

- [ ] **Step 3: Build consolidated groups for the Ordered column**

After the existing `cardsByStage` memo, add a memo that consolidates ordered PRs (awaiting-PO only) and lists PO-backed cards separately:

```tsx
  const ordered = useMemo(() => {
    const rows = grouped.ordered
    const awaiting = rows.filter((r) => r.status === 'ordered')
    const withPo = rows.filter((r) => r.status === 'converted_to_po')
    const groups = consolidatePrs(
      awaiting.map((r) => ({
        id: r.id,
        materialId: r.materialId,
        materialCode: r.material.materialCode,
        boardType: r.boardType,
        gsm: r.gsm,
        sizeLabel: r.sizeLabel,
        qty: Number(r.qtyRequired),
        supplierId: r.supplierId,
        requiredByDate: r.requiredByDate,
      })),
    )
    return { groups, withPo }
  }, [grouped.ordered])
```

- [ ] **Step 4: Add the Generate PO trigger**

Add a handler that opens the dialog from the current `orderedSel`:

```tsx
  function openGeneratePo() {
    const ids = Array.from(orderedSel)
    if (ids.length === 0) return
    const selectedGroups = ordered.groups.filter((g) => g.members.some((m) => orderedSel.has(m.prId)))
    const summary = selectedGroups.map((g) => ({
      materialCode: g.materialCode,
      boardType: g.boardType,
      gsm: g.gsm,
      sizeLabel: g.sizeLabel,
      totalQty: g.members.filter((m) => orderedSel.has(m.prId)).reduce((s, m) => s + m.qty, 0),
      prCount: g.members.filter((m) => orderedSel.has(m.prId)).length,
    }))
    const suggested = selectedGroups[0]?.suggestedSupplierId ?? null
    setPoSelection({ prIds: ids, summary, suggestedVendorId: suggested })
    setPoDialogOpen(true)
  }
```

- [ ] **Step 5: Render the Ordered column with consolidated cards + replace other columns' cards with compact cards**

In the column render loop (~lines 349-467), special-case the Ordered column to render `ordered.groups` (awaiting-PO consolidated cards, selectable) followed by `ordered.withPo` rows (monitoring cards). For Draft/Approved/Received columns, render `grouped[stage.key]` rows directly as `PrCompactCard` (no more material-grouping for those columns). Concretely, inside the column `<div className="space-y-2">`:

```tsx
                {stage.key === 'ordered' ? (
                  <>
                    {ordered.groups.map((g) => {
                      const allSelected = g.members.every((m) => orderedSel.has(m.prId))
                      return (
                        <OrderedConsolidatedCard
                          key={`og-${g.key}`}
                          materialCode={g.materialCode}
                          boardType={g.boardType}
                          gsm={g.gsm}
                          sizeLabel={g.sizeLabel}
                          totalQty={g.totalQty}
                          memberCount={g.members.length}
                          monitoring={null}
                          selectable
                          selected={allSelected}
                          onToggleSelect={() =>
                            setOrderedSel((prev) => {
                              const next = new Set(prev)
                              const ids = g.members.map((m) => m.prId)
                              const on = !ids.every((id) => next.has(id))
                              for (const id of ids) on ? next.add(id) : next.delete(id)
                              return next
                            })
                          }
                          onOpen={() => { setEditPrId(g.members[0]!.prId); setEditOpen(true) }}
                        />
                      )
                    })}
                    {ordered.withPo.map((r) => (
                      <OrderedConsolidatedCard
                        key={`po-${r.id}`}
                        materialCode={r.material.materialCode}
                        boardType={r.boardType}
                        gsm={r.gsm}
                        sizeLabel={r.sizeLabel}
                        totalQty={Number(r.qtyRequired)}
                        memberCount={1}
                        monitoring={r.monitoring ?? null}
                        selectable={false}
                        selected={false}
                        onToggleSelect={() => {}}
                        onOpen={() => { setEditPrId(r.id); setEditOpen(true) }}
                      />
                    ))}
                  </>
                ) : (
                  grouped[stage.key].map((r) => (
                    <PrCompactCard
                      key={`${stage.key}-${r.id}`}
                      pr={r}
                      selectable={false}
                      onOpen={() => { setEditPrId(r.id); setEditOpen(true) }}
                    />
                  ))
                )}
```

Keep the existing empty-state `<p>` after this block. (The old per-card `moveStage`/`deleteCard` buttons are replaced; moving between Draft/Approved/Received now happens from the drawer's Approve button and a small per-card move control you can keep in `PrCompactCard` if desired. For Approved→Ordered, add a column-level "Move selected → Ordered" button — see Step 6.)

**Also remove the now-stale per-column header select-all checkbox** (original lines ~354-374). It read from the removed `cardsByStage`/`groupedByMaterial` data and the per-card grouped checkbox model. Replace the column header with a plain title + count:

```tsx
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-ds-ink">{stage.label}</h2>
                <span className="rounded border border-ds-line/40 px-2 py-0.5 text-xs text-ds-ink-muted">{rows.length}</span>
              </div>
```

Selection in the Ordered column is now driven by `orderedSel` (per consolidated card) and the toolbar Generate PO button — the old `selectedCardIds`/`cardsByStage` machinery and its `bulkDeleteSelected`/`bulkMoveSelected('received')` buttons can be deleted unless you keep "Move selected → Ordered". Remove any resulting unused state/memos to satisfy lint.

- [ ] **Step 6: Replace the top toolbar's bulk buttons**

Replace the existing bulk-action buttons (~lines 320-344) with:
- a **Generate PO** button enabled when `orderedSel.size > 0`, calling `openGeneratePo()`;
- keep "Move Selected → Ordered" using the existing `bulkMoveSelected('ordered')` (it now sets the `ordered` status via the adjusted stage route);
- drop the fake `poReference` auto-string in `moveStage`/`bulkMoveSelected` (delete the `if (stage === 'ordered' && !pr.poReference) { body.poReference = ... }` lines so no fake reference is sent).

```tsx
          <button
            type="button"
            disabled={orderedSel.size === 0}
            onClick={openGeneratePo}
            className="rounded border border-[var(--success)]/40 bg-[var(--success-bg)] px-2 py-1 text-xs text-[var(--success)] disabled:opacity-40"
          >
            Generate PO ({orderedSel.size})
          </button>
```

- [ ] **Step 7: Mount the drawer and dialog; drop the old TraceabilityDrawer trigger**

Near the bottom of the returned JSX (where `<TraceabilityDrawer .../>` is mounted), add:

```tsx
      <PrEditDrawer
        prId={editPrId}
        open={editOpen}
        onClose={() => { setEditOpen(false); setEditPrId(null) }}
        onSaved={() => { refresh(); window.dispatchEvent(new Event('inventory:refresh')) }}
      />
      <GeneratePoDialog
        open={poDialogOpen}
        selection={poSelection}
        onClose={() => setPoDialogOpen(false)}
        onCreated={() => { setOrderedSel(new Set()); refresh(); window.dispatchEvent(new Event('inventory:refresh')) }}
      />
```

You may keep `TraceabilityDrawer` available, but the primary click now opens `PrEditDrawer`. Remove `openTraceability` wiring from cards if it causes duplicate drawers.

- [ ] **Step 8: Typecheck and lint**

Run: `npm run typecheck`
Expected: PASS. Resolve any unused-variable lint errors from removed code (e.g. delete now-unused `cardsByStage` if the only consumer was the old render, or keep it if still used by the column count).

- [ ] **Step 9: Commit**

```bash
git add "src/app/(dashboard)/inventory/purchase-requisitions/page.tsx"
git commit -m "feat(pr): wire compact cards, edit drawer, ordered consolidation + generate PO"
```

---

## Task 12: Browser verification + full suite

**Files:** none (verification only)

- [ ] **Step 1: Start the dev server**

Use `preview_start` (or confirm one is running with `preview_list`). Navigate to `/inventory/purchase-requisitions`.

- [ ] **Step 2: Verify the board renders with compact cards**

Use `preview_snapshot`. Confirm four columns, compact cards (~2 lines), no console errors (`preview_console_logs`).

- [ ] **Step 3: Verify the draft edit flow**

Click a Draft card (`preview_click`), edit Board Type/GSM/Qty/Remarks in the drawer, Save. Re-open and confirm values persisted and a Revision History entry appears. Then Approve and confirm fields lock.

- [ ] **Step 4: Verify Approved → Ordered consolidation**

Move ≥2 approved PRs of the same material/board/gsm/size to Ordered (no popup should appear). Confirm they render as a single consolidated card showing the summed total and "Awaiting PO".

- [ ] **Step 5: Verify single + bulk Generate PO**

Select one consolidated card → Generate PO → pick vendor + terms → confirm. Card flips to a monitoring view (PO number, Ordered/Received/Balance). Repeat selecting multiple cards for a bulk PO. Confirm `preview_network` shows the `generate-po` POST returning 200.

- [ ] **Step 6: Run the full test suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Final commit (if any verification fixes were needed)**

```bash
git add -A
git commit -m "test(pr): browser-verified PR Kanban procurement flow"
```

---

## Notes for the implementer

- **Roles:** all mutating endpoints use `requireRole('stores','production_manager','operations_head','md')` — match this exactly.
- **Audit:** never write monitoring/received numbers from the board — they are derived from `VendorMaterialReceipt` rollups (`totalReceivedKg`). GRN remains the sole receiving authority.
- **Legacy ordered rows** may sit at `converted_to_po` with a fake `AUTO-...` poReference and no real PO. `monitoring` will be `null` for them (the join finds no PO) — the monitoring card already degrades to the "Awaiting PO" / total view; verify this renders without error in Step 5.
- **Decimals:** Prisma returns `Decimal` — always wrap with `Number(...)` before arithmetic or `toLocaleString`.
