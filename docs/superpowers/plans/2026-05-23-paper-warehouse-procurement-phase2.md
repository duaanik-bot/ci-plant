# Paper Warehouse Procurement Hub — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the Paper Warehouse page into a tabbed procurement hub with RAG status, unified material drawer, direct PO fast-track, Open POs + Incoming tabs, smart suggestions, KPI strip, and Reports tab.

**Architecture:** Schema-first (one additive FK), then pure-function libs with Vitest TDD, then API endpoints, then UI components bottom-up (KPI strip → drawer → dialogs → tabs → shell page). The 2,736-line `inventory/page.tsx` is extracted into a ~300-line shell + focused tab components. All new UI uses `GlobalPopoutModal` and existing `ds-*` design tokens.

**Tech Stack:** Next.js 15 App Router, TypeScript, Prisma 6, Tailwind CSS, `@tanstack/react-query`, Vitest, `GlobalPopoutModal` from `@/components/design-system/GlobalPopoutModal`.

> ⚠️ **Branch from `staging-supabase`**, not `main`. Phase 1 work (VendorPoRequisitionLink, ordered status, paymentTerms/transportTerms on VendorMaterialPurchaseOrder) lives there.
> ⚠️ **Never run `prisma migrate dev`** — `DATABASE_URL` points to the production Neon DB. Always `prisma migrate deploy`.

---

## File Map

### Created
- `prisma/migrations/20260523000000_vendor_po_material_fk/migration.sql`
- `src/lib/procurement-rag.ts`
- `src/lib/procurement-rag.test.ts`
- `src/lib/procurement-suggestions.ts`
- `src/lib/procurement-suggestions.test.ts`
- `src/app/api/inventory/paper-warehouse/open-pos/route.ts`
- `src/app/api/inventory/paper-warehouse/reports/route.ts`
- `src/app/api/inventory/paper-warehouse/[id]/open-pos/route.ts`
- `src/app/api/inventory/paper-warehouse/[id]/direct-po/route.ts`
- `src/app/(dashboard)/inventory/components/WarehouseKpiStrip.tsx`
- `src/app/(dashboard)/inventory/components/StockTab.tsx`
- `src/app/(dashboard)/inventory/components/OpenPosTab.tsx`
- `src/app/(dashboard)/inventory/components/IncomingTab.tsx`
- `src/app/(dashboard)/inventory/components/ReportsTab.tsx`
- `src/app/(dashboard)/inventory/components/MaterialDrawer.tsx`
- `src/app/(dashboard)/inventory/components/DirectPoDialog.tsx`

### Modified
- `prisma/schema.prisma` — add `materialId` nullable FK on `VendorMaterialPurchaseOrder`
- `src/app/api/inventory/paper-warehouse/route.ts` — add `hasOpenPo` to each row
- `src/app/api/purchase-requisitions/route.ts` — add `?materialId=` filter
- `src/app/(dashboard)/inventory/page.tsx` — extract to shell + wire tabs

---

## Task 1: Schema migration — materialId FK on VendorMaterialPurchaseOrder

**Files:**
- Modify: `prisma/schema.prisma` (around line 1165 — after the `purchaseRequisition` relation)
- Create: `prisma/migrations/20260523000000_vendor_po_material_fk/migration.sql`

- [ ] **Step 1: Add field + relation to schema**

In `prisma/schema.prisma`, inside `model VendorMaterialPurchaseOrder`, add after the `purchaseRequisitionId` field and its relation:

```prisma
  /// Direct FK to Inventory for fast-track POs created without a PR.
  /// PR-linked POs leave this null — reached via VendorPoRequisitionLink instead.
  materialId               String?   @map("material_id")

  material            Inventory?                        @relation(fields: [materialId], references: [id], onDelete: SetNull)
```

Also add the reverse relation to `model Inventory` (near the bottom of that model, after `purchaseRequisitions PurchaseRequisition[]`):

```prisma
  vendorMaterialPos    VendorMaterialPurchaseOrder[]
```

- [ ] **Step 2: Create migration file**

Create `prisma/migrations/20260523000000_vendor_po_material_fk/migration.sql`:

```sql
-- AlterTable: add materialId FK to vendor_material_purchase_orders
ALTER TABLE "vendor_material_purchase_orders" ADD COLUMN "material_id" TEXT;

-- AddForeignKey
ALTER TABLE "vendor_material_purchase_orders"
  ADD CONSTRAINT "vendor_material_purchase_orders_material_id_fkey"
  FOREIGN KEY ("material_id") REFERENCES "inventory"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "vendor_material_purchase_orders_material_id_idx"
  ON "vendor_material_purchase_orders"("material_id");
```

- [ ] **Step 3: Apply migration to Neon DB**

```bash
npx prisma migrate deploy
```

Expected output contains:
```
Applying migration `20260523000000_vendor_po_material_fk`
All migrations have been successfully applied.
```

- [ ] **Step 4: Regenerate Prisma client**

```bash
npx prisma generate
```

Expected: `✔ Generated Prisma Client` with no errors.

- [ ] **Step 5: Verify typecheck**

```bash
npm run typecheck
```

Expected: silent (zero errors).

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260523000000_vendor_po_material_fk/migration.sql
git commit -m "feat(schema): add materialId FK on VendorMaterialPurchaseOrder for direct warehouse POs"
```

---

## Task 2: RAG signal lib (TDD)

**Files:**
- Create: `src/lib/procurement-rag.ts`
- Create: `src/lib/procurement-rag.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/procurement-rag.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { computeRag } from './procurement-rag'

const base = {
  shortage_sheets: 0,
  open_pr_id: null,
  open_pr_status: null,
  hasOpenPo: false,
}

describe('computeRag', () => {
  it('returns green when no shortage', () => {
    expect(computeRag({ ...base, shortage_sheets: 0 })).toBe('green')
  })

  it('returns green when shortage_sheets is negative', () => {
    expect(computeRag({ ...base, shortage_sheets: -100 })).toBe('green')
  })

  it('returns amber when shortage and open PR (not received)', () => {
    expect(computeRag({ ...base, shortage_sheets: 500, open_pr_id: 'pr1', open_pr_status: 'approved' })).toBe('amber')
  })

  it('returns amber when shortage and open PO', () => {
    expect(computeRag({ ...base, shortage_sheets: 500, hasOpenPo: true })).toBe('amber')
  })

  it('returns red when shortage and nothing ordered', () => {
    expect(computeRag({ ...base, shortage_sheets: 500 })).toBe('red')
  })

  it('returns red when shortage and PR is received (closed)', () => {
    expect(computeRag({ ...base, shortage_sheets: 500, open_pr_id: 'pr1', open_pr_status: 'received' })).toBe('red')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test src/lib/procurement-rag.test.ts
```

Expected: FAIL — "Cannot find module './procurement-rag'"

- [ ] **Step 3: Implement the lib**

Create `src/lib/procurement-rag.ts`:

```typescript
export type ProcurementRag = 'green' | 'amber' | 'red'

export function computeRag(row: {
  shortage_sheets: number
  open_pr_id: string | null
  open_pr_status: string | null
  hasOpenPo: boolean
}): ProcurementRag {
  if (row.shortage_sheets <= 0) return 'green'
  if (row.hasOpenPo) return 'amber'
  if (row.open_pr_id && row.open_pr_status !== 'received') return 'amber'
  return 'red'
}

/** Tailwind border class for the left-border row indicator. */
export function ragBorderClass(rag: ProcurementRag): string {
  if (rag === 'green') return 'border-l-2 border-ds-success'
  if (rag === 'amber') return 'border-l-2 border-ds-warning'
  return 'border-l-2 border-ds-error'
}

/** Tailwind background class for the status dot. */
export function ragDotClass(rag: ProcurementRag): string {
  if (rag === 'green') return 'bg-ds-success'
  if (rag === 'amber') return 'bg-ds-warning'
  return 'bg-ds-error'
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test src/lib/procurement-rag.test.ts
```

Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/procurement-rag.ts src/lib/procurement-rag.test.ts
git commit -m "feat(rag): procurement RAG signal lib with 6 unit tests"
```

---

## Task 3: Procurement suggestions lib (TDD)

**Files:**
- Create: `src/lib/procurement-suggestions.ts`
- Create: `src/lib/procurement-suggestions.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/procurement-suggestions.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { computeSuggestion } from './procurement-suggestions'

const base = {
  shortage_sheets: 0,
  incoming_sheets: 0,
  reorder_level: 1000,
  daysOfCover: 30,
  packet_weight: 0.5,
}

describe('computeSuggestion', () => {
  it('returns null when no shortage', () => {
    expect(computeSuggestion({ ...base, shortage_sheets: 0 })).toBeNull()
  })

  it('uses reorder_level when it exceeds shortage', () => {
    const result = computeSuggestion({ ...base, shortage_sheets: 400, reorder_level: 1000 })
    expect(result).not.toBeNull()
    expect(result!.suggestedKg).toBeCloseTo(1000 * 0.5)
    expect(result!.basis).toBe('reorder_level')
  })

  it('uses shortage_sheets when it exceeds reorder_level', () => {
    const result = computeSuggestion({ ...base, shortage_sheets: 2000, reorder_level: 500 })
    expect(result).not.toBeNull()
    expect(result!.suggestedKg).toBeCloseTo(2000 * 0.5)
    expect(result!.basis).toBe('consumption')
  })

  it('subtracts incoming_sheets from net shortage', () => {
    // shortage=1000, incoming=600 → net=400; reorder_level=1000 > net → uses reorder_level
    const result = computeSuggestion({ ...base, shortage_sheets: 1000, incoming_sheets: 600, reorder_level: 1000 })
    expect(result).not.toBeNull()
    expect(result!.suggestedKg).toBeCloseTo(1000 * 0.5) // reorder_level wins
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test src/lib/procurement-suggestions.test.ts
```

Expected: FAIL — "Cannot find module './procurement-suggestions'"

- [ ] **Step 3: Implement the lib**

Create `src/lib/procurement-suggestions.ts`:

```typescript
export type ProcurementSuggestion = {
  suggestedKg: number
  coversDays: number
  basis: 'reorder_level' | 'consumption'
}

const COVER_DAYS_TARGET = 45
const COVER_DAYS_MAX = 90

export function computeSuggestion(row: {
  shortage_sheets: number
  incoming_sheets: number
  reorder_level: number
  daysOfCover: number | null
  packet_weight: number
}): ProcurementSuggestion | null {
  const netShortage = Math.max(0, row.shortage_sheets - row.incoming_sheets)
  if (netShortage <= 0) return null

  const basis: ProcurementSuggestion['basis'] =
    row.reorder_level > netShortage ? 'reorder_level' : 'consumption'

  const baseSheets = Math.max(row.reorder_level, netShortage)
  // Cap at 90-day buffer: if daysOfCover after ordering would exceed 90, reduce.
  const dailyConsumption =
    row.daysOfCover && row.daysOfCover > 0
      ? netShortage / Math.max(row.daysOfCover, 1)
      : 0
  const maxSheets =
    dailyConsumption > 0
      ? Math.ceil(dailyConsumption * COVER_DAYS_MAX)
      : baseSheets

  const suggestedSheets = Math.min(baseSheets, maxSheets)
  const suggestedKg = suggestedSheets * row.packet_weight
  const coversDays =
    dailyConsumption > 0
      ? Math.round(suggestedSheets / dailyConsumption)
      : COVER_DAYS_TARGET

  return { suggestedKg, coversDays, basis }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test src/lib/procurement-suggestions.test.ts
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/procurement-suggestions.ts src/lib/procurement-suggestions.test.ts
git commit -m "feat(suggestions): procurement suggestion lib with 4 unit tests"
```

---

## Task 4: Extend warehouse list API with hasOpenPo

**Files:**
- Modify: `src/app/api/inventory/paper-warehouse/route.ts`

- [ ] **Step 1: Read the file to understand current structure**

```bash
head -100 src/app/api/inventory/paper-warehouse/route.ts
```

Find the section where material rows are assembled for the response.

- [ ] **Step 2: Add hasOpenPo join-count to the list query**

In the `GET` handler, after fetching the inventory rows, add a bulk lookup:

```typescript
// Fetch set of materialIds that have at least one active PO
// (either via VendorPoRequisitionLink or via direct materialId FK)
const allMaterialIds = rows.map((r) => r.id)

const [prLinkedPoMaterialIds, directPoMaterialIds] = await Promise.all([
  db.vendorPoRequisitionLink
    .findMany({
      where: {
        pr: { materialId: { in: allMaterialIds } },
        vendorPo: { isShortClosed: false, status: { not: 'received' } },
      },
      select: { pr: { select: { materialId: true } } },
    })
    .then((rows) => new Set(rows.map((r) => r.pr.materialId).filter(Boolean) as string[])),
  db.vendorMaterialPurchaseOrder
    .findMany({
      where: {
        materialId: { in: allMaterialIds },
        isShortClosed: false,
        status: { not: 'received' },
      },
      select: { materialId: true },
    })
    .then((rows) => new Set(rows.map((r) => r.materialId).filter(Boolean) as string[])),
])

const openPoMaterialIds = new Set([...prLinkedPoMaterialIds, ...directPoMaterialIds])
```

Then in the row mapping, add `hasOpenPo`:

```typescript
hasOpenPo: openPoMaterialIds.has(row.id),
```

- [ ] **Step 3: Add hasOpenPo to the TypeScript row type**

In the same file (or in the type definition used by the warehouse page), add:

```typescript
hasOpenPo: boolean
```

- [ ] **Step 4: Verify typecheck**

```bash
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/inventory/paper-warehouse/route.ts
git commit -m "feat(api): add hasOpenPo to paper warehouse list response"
```

---

## Task 5: Extend PR list endpoint with materialId filter

**Files:**
- Modify: `src/app/api/purchase-requisitions/route.ts`

- [ ] **Step 1: Add materialId query param parsing**

In the `GET` handler, near where other query params are parsed:

```typescript
const materialId = searchParams.get('materialId')
```

- [ ] **Step 2: Add filter to the Prisma where clause**

Where the `where` object is built for `db.purchaseRequisition.findMany`, add:

```typescript
...(materialId ? { materialId } : {}),
```

- [ ] **Step 3: Verify typecheck**

```bash
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/purchase-requisitions/route.ts
git commit -m "feat(api): PR list supports ?materialId= filter for material drawer"
```

---

## Task 6: Per-material open-pos endpoint

**Files:**
- Create: `src/app/api/inventory/paper-warehouse/[id]/open-pos/route.ts`

- [ ] **Step 1: Create the route file**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { error } = await requireAuth()
  if (error) return error

  const { id: materialId } = await context.params

  // Path 1: PR-linked POs
  const prLinked = await db.vendorMaterialPurchaseOrder.findMany({
    where: {
      isShortClosed: false,
      status: { not: 'received' },
      requisitionLinks: {
        some: { pr: { materialId } },
      },
    },
    include: {
      supplier: { select: { name: true } },
      lines: { select: { totalWeightKg: true } },
      requisitionLinks: { select: { purchaseRequisitionId: true } },
    },
  })

  // Path 2: Direct fast-track POs
  const direct = await db.vendorMaterialPurchaseOrder.findMany({
    where: {
      materialId,
      isShortClosed: false,
      status: { not: 'received' },
    },
    include: {
      supplier: { select: { name: true } },
      lines: { select: { totalWeightKg: true } },
      requisitionLinks: { select: { purchaseRequisitionId: true } },
    },
  })

  // Merge and deduplicate by PO id
  const seen = new Set<string>()
  const all = [...prLinked, ...direct].filter((po) => {
    if (seen.has(po.id)) return false
    seen.add(po.id)
    return true
  })

  const result = all.map((po) => {
    const orderedKg = po.lines.reduce((s, l) => s + Number(l.totalWeightKg), 0)
    const receivedKg = Number(po.totalReceivedKg)
    return {
      id: po.id,
      poNumber: po.poNumber,
      vendorName: po.supplier.name,
      orderedKg,
      receivedKg,
      pendingKg: Math.max(0, orderedKg - receivedKg),
      requiredDeliveryDate: po.requiredDeliveryDate?.toISOString().slice(0, 10) ?? null,
      status: po.status,
      logisticsStatus: po.logisticsStatus,
      linkedPrIds: po.requisitionLinks.map((l) => l.purchaseRequisitionId),
    }
  })

  return NextResponse.json(result)
}
```

- [ ] **Step 2: Verify typecheck**

```bash
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add "src/app/api/inventory/paper-warehouse/[id]/open-pos/route.ts"
git commit -m "feat(api): per-material open-pos endpoint for material drawer"
```

---

## Task 7: Board-wide open-pos endpoint

**Files:**
- Create: `src/app/api/inventory/paper-warehouse/open-pos/route.ts`

- [ ] **Step 1: Create the route file**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const pos = await db.vendorMaterialPurchaseOrder.findMany({
    where: {
      isShortClosed: false,
      status: { not: 'received' },
    },
    include: {
      supplier: { select: { name: true } },
      lines: { select: { totalWeightKg: true } },
      material: { select: { materialCode: true } },
      requisitionLinks: {
        select: {
          purchaseRequisitionId: true,
          pr: { select: { materialId: true, material: { select: { materialCode: true } } } },
        },
        take: 1,
      },
    },
    orderBy: { requiredDeliveryDate: 'asc' },
  })

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const result = pos.map((po) => {
    const orderedKg = po.lines.reduce((s, l) => s + Number(l.totalWeightKg), 0)
    const receivedKg = Number(po.totalReceivedKg)
    const pendingKg = Math.max(0, orderedKg - receivedKg)

    // Resolve materialCode: direct FK first, then first linked PR's material
    const materialCode =
      po.material?.materialCode ??
      po.requisitionLinks[0]?.pr?.material?.materialCode ??
      null

    const daysOverdue = po.requiredDeliveryDate
      ? Math.floor((today.getTime() - po.requiredDeliveryDate.getTime()) / 86_400_000)
      : null

    return {
      id: po.id,
      poNumber: po.poNumber,
      vendorName: po.supplier.name,
      materialCode,
      orderedKg,
      receivedKg,
      pendingKg,
      requiredDeliveryDate: po.requiredDeliveryDate?.toISOString().slice(0, 10) ?? null,
      status: po.status,
      logisticsStatus: po.logisticsStatus,
      daysOverdue,
      linkedPrIds: po.requisitionLinks.map((l) => l.purchaseRequisitionId),
    }
  })

  return NextResponse.json(result)
}
```

- [ ] **Step 2: Verify typecheck**

```bash
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/inventory/paper-warehouse/open-pos/route.ts
git commit -m "feat(api): board-wide open-pos endpoint for Open POs tab"
```

---

## Task 8: Reports endpoint

**Files:**
- Create: `src/app/api/inventory/paper-warehouse/reports/route.ts`

- [ ] **Step 1: Create the route file**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const ninetyDaysAgo = new Date()
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90)

  const pos = await db.vendorMaterialPurchaseOrder.findMany({
    where: { orderDate: { gte: ninetyDaysAgo } },
    include: {
      supplier: { select: { name: true } },
      lines: { select: { totalWeightKg: true, ratePerKg: true } },
      receipts: {
        select: { createdAt: true },
        orderBy: { createdAt: 'asc' },
        take: 1,
      },
    },
  })

  // Spend by vendor
  const spendMap = new Map<string, { totalInr: number; poCount: number }>()
  for (const po of pos) {
    const name = po.supplier.name
    const spend = po.lines.reduce(
      (s, l) => s + Number(l.totalWeightKg) * Number(l.ratePerKg ?? 0),
      0,
    )
    const cur = spendMap.get(name) ?? { totalInr: 0, poCount: 0 }
    spendMap.set(name, { totalInr: cur.totalInr + spend, poCount: cur.poCount + 1 })
  }
  const spendByVendor = Array.from(spendMap.entries())
    .map(([vendorName, v]) => ({ vendorName, ...v }))
    .sort((a, b) => b.totalInr - a.totalInr)

  // Receipt accuracy by vendor
  const accuracyMap = new Map<string, { orderedKg: number; receivedKg: number }>()
  for (const po of pos) {
    const name = po.supplier.name
    const orderedKg = po.lines.reduce((s, l) => s + Number(l.totalWeightKg), 0)
    const receivedKg = Number(po.totalReceivedKg)
    const cur = accuracyMap.get(name) ?? { orderedKg: 0, receivedKg: 0 }
    accuracyMap.set(name, {
      orderedKg: cur.orderedKg + orderedKg,
      receivedKg: cur.receivedKg + receivedKg,
    })
  }
  const receiptAccuracy = Array.from(accuracyMap.entries()).map(([vendorName, v]) => ({
    vendorName,
    orderedKg: v.orderedKg,
    receivedKg: v.receivedKg,
    accuracyPct: v.orderedKg > 0 ? Math.round((v.receivedKg / v.orderedKg) * 100) : 0,
  }))

  // Lead time trend — avg days from orderDate to first receipt, grouped by month
  const leadMap = new Map<string, { totalDays: number; count: number }>()
  for (const po of pos) {
    const firstReceipt = po.receipts[0]
    if (!firstReceipt) continue
    const days = Math.floor(
      (firstReceipt.createdAt.getTime() - po.orderDate.getTime()) / 86_400_000,
    )
    if (days < 0) continue
    const month = po.orderDate.toISOString().slice(0, 7) // "2026-05"
    const cur = leadMap.get(month) ?? { totalDays: 0, count: 0 }
    leadMap.set(month, { totalDays: cur.totalDays + days, count: cur.count + 1 })
  }
  const leadTimeTrend = Array.from(leadMap.entries())
    .map(([month, v]) => ({ month, avgDays: Math.round(v.totalDays / v.count) }))
    .sort((a, b) => a.month.localeCompare(b.month))
    .slice(-6)

  return NextResponse.json({ spendByVendor, receiptAccuracy, leadTimeTrend })
}
```

- [ ] **Step 2: Verify typecheck**

```bash
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/inventory/paper-warehouse/reports/route.ts
git commit -m "feat(api): warehouse reports endpoint (spend, accuracy, lead time)"
```

---

## Task 9: Direct PO endpoint

**Files:**
- Create: `src/app/api/inventory/paper-warehouse/[id]/direct-po/route.ts`

- [ ] **Step 1: Create the route file**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireRole } from '@/lib/helpers'
import { db } from '@/lib/db'
import { createAuditLog } from '@/lib/audit'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  supplierId: z.string().uuid(),
  qtyKg: z.number().positive(),
  sizeLabel: z.string().optional(),
  ratePerKg: z.number().positive().optional(),
  deliveryDate: z.string().datetime().optional(),
  paymentTerms: z.string().max(200).optional(),
  transportTerms: z.string().max(200).optional(),
  remarks: z.string().max(500).optional(),
})

function buildPoNumber(existingMax: string | null): string {
  const now = new Date()
  const yyyymmdd =
    `${now.getFullYear()}` +
    `${String(now.getMonth() + 1).padStart(2, '0')}` +
    `${String(now.getDate()).padStart(2, '0')}`
  const prefix = `PO-${yyyymmdd}-`
  if (!existingMax || !existingMax.startsWith(prefix)) return `${prefix}001`
  const seq = parseInt(existingMax.replace(prefix, ''), 10) || 0
  return `${prefix}${String(seq + 1).padStart(3, '0')}`
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error, user } = await requireRole(
    'stores',
    'production_manager',
    'operations_head',
    'md',
  )
  if (error) return error

  const { id: materialId } = await context.params

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body', details: parsed.error.flatten() }, { status: 400 })
  }

  const { supplierId, qtyKg, ratePerKg, deliveryDate, paymentTerms, transportTerms, remarks } =
    parsed.data

  const material = await db.inventory.findUnique({ where: { id: materialId } })
  if (!material) return NextResponse.json({ error: 'Material not found' }, { status: 404 })
  if (!material.boardType || material.gsm == null) {
    return NextResponse.json(
      { error: 'Material is missing boardType or gsm — cannot create PO line' },
      { status: 400 },
    )
  }

  const supplier = await db.supplier.findFirst({ where: { id: supplierId, active: true } })
  if (!supplier) return NextResponse.json({ error: 'Supplier not found' }, { status: 404 })

  const result = await db.$transaction(async (tx) => {
    const prefix = `PO-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-`
    const latest = await tx.vendorMaterialPurchaseOrder.findFirst({
      where: { poNumber: { startsWith: prefix } },
      orderBy: { poNumber: 'desc' },
      select: { poNumber: true },
    })
    const poNumber = buildPoNumber(latest?.poNumber ?? null)

    const po = await tx.vendorMaterialPurchaseOrder.create({
      data: {
        poNumber,
        supplierId,
        materialId,
        createdBy: user!.id,
        requiredDeliveryDate: deliveryDate ? new Date(deliveryDate) : undefined,
        paymentTerms,
        transportTerms,
        remarks,
        lines: {
          create: [
            {
              boardGrade: material.boardType!,
              gsm: material.gsm!,
              totalSheets: 0,
              totalWeightKg: qtyKg,
              ...(ratePerKg ? { ratePerKg } : {}),
              linkedPoLineIds: [],
            },
          ],
        },
      },
    })
    return po
  })

  await createAuditLog({
    userId: user!.id,
    action: 'CREATE',
    tableName: 'vendor_material_purchase_orders',
    recordId: result.id,
    oldValue: null,
    newValue: { poNumber: result.poNumber, materialId, supplierId, qtyKg },
  })

  return NextResponse.json({ poId: result.id, poNumber: result.poNumber })
}
```

- [ ] **Step 2: Verify typecheck**

```bash
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add "src/app/api/inventory/paper-warehouse/[id]/direct-po/route.ts"
git commit -m "feat(api): direct PO fast-track endpoint from paper warehouse"
```

---

## Task 10: KPI strip component

**Files:**
- Create: `src/app/(dashboard)/inventory/components/WarehouseKpiStrip.tsx`

- [ ] **Step 1: Create the component**

```typescript
'use client'

import { cn } from '@/lib/cn'
import type { ProcurementRag } from '@/lib/procurement-rag'

type KpiTileProps = {
  label: string
  value: string | number
  colorClass: string
  onClick?: () => void
}

function KpiTile({ label, value, colorClass, onClick }: KpiTileProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={cn(
        'flex flex-col gap-0.5 rounded-ds-md border border-ds-line/30 bg-ds-elevated/60 px-4 py-3 text-left',
        onClick && 'cursor-pointer hover:bg-ds-elevated transition-colors',
        !onClick && 'cursor-default',
      )}
    >
      <span className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint">{label}</span>
      <span className={cn('text-xl font-bold tabular-nums leading-tight', colorClass)}>{value}</span>
    </button>
  )
}

type Props = {
  ragCounts: Record<ProcurementRag, number>
  incomingKgThisWeek: number
  openPoValueInr: number
  avgDaysOfCover: number | null
  onFilterRed: () => void
  onFilterAmber: () => void
  onSwitchToOpenPos: () => void
  onSwitchToIncoming: () => void
}

const nf = new Intl.NumberFormat('en-IN')

export function WarehouseKpiStrip({
  ragCounts,
  incomingKgThisWeek,
  openPoValueInr,
  avgDaysOfCover,
  onFilterRed,
  onFilterAmber,
  onSwitchToOpenPos,
  onSwitchToIncoming,
}: Props) {
  const docColor =
    avgDaysOfCover == null
      ? 'text-ds-ink-muted'
      : avgDaysOfCover > 30
        ? 'text-ds-success'
        : avgDaysOfCover >= 10
          ? 'text-ds-warning'
          : 'text-ds-error'

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
      <KpiTile
        label="In shortage"
        value={ragCounts.red}
        colorClass="text-ds-error"
        onClick={onFilterRed}
      />
      <KpiTile
        label="Being handled"
        value={ragCounts.amber}
        colorClass="text-ds-warning"
        onClick={onFilterAmber}
      />
      <KpiTile
        label="Incoming this week"
        value={`${nf.format(Math.round(incomingKgThisWeek))} kg`}
        colorClass="text-ds-ink"
        onClick={onSwitchToIncoming}
      />
      <KpiTile
        label="Open PO value"
        value={`₹${nf.format(Math.round(openPoValueInr / 1000))}k`}
        colorClass="text-ds-ink"
        onClick={onSwitchToOpenPos}
      />
      <KpiTile
        label="Avg days of cover"
        value={avgDaysOfCover != null ? `${Math.round(avgDaysOfCover)}d` : '—'}
        colorClass={docColor}
      />
    </div>
  )
}
```

- [ ] **Step 2: Verify typecheck**

```bash
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add src/app/\(dashboard\)/inventory/components/WarehouseKpiStrip.tsx
git commit -m "feat(ui): WarehouseKpiStrip — 5 actionable KPI tiles"
```

---

## Task 11: DirectPoDialog component

**Files:**
- Create: `src/app/(dashboard)/inventory/components/DirectPoDialog.tsx`

- [ ] **Step 1: Create the component**

```typescript
'use client'

import { useState, useEffect } from 'react'
import { GlobalPopoutModal } from '@/components/design-system/GlobalPopoutModal'
import { toast } from '@/store/toastStore'

type Vendor = { id: string; name: string }

export type DirectPoDialogProps = {
  isOpen: boolean
  onClose: () => void
  onSuccess: () => void
  materialId: string
  materialCode: string
  boardType: string | null
  gsm: number | null
  /** 'direct' = fast-track PO with no PR. 'from-pr' = generate PO for an existing PR. */
  mode: 'direct' | 'from-pr'
  prId?: string
  prefillQty?: number
}

export function DirectPoDialog({
  isOpen,
  onClose,
  onSuccess,
  materialId,
  materialCode,
  boardType,
  gsm,
  mode,
  prId,
  prefillQty,
}: DirectPoDialogProps) {
  const [vendors, setVendors] = useState<Vendor[]>([])
  const [supplierId, setSupplierId] = useState('')
  const [qtyKg, setQtyKg] = useState(prefillQty ? String(prefillQty) : '')
  const [deliveryDate, setDeliveryDate] = useState('')
  const [paymentTerms, setPaymentTerms] = useState('')
  const [transportTerms, setTransportTerms] = useState('')
  const [remarks, setRemarks] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!isOpen) return
    fetch('/api/procurement/suppliers')
      .then((r) => r.json())
      .then((d) => setVendors(Array.isArray(d) ? d : d.suppliers ?? []))
      .catch(() => {})
  }, [isOpen])

  useEffect(() => {
    if (prefillQty) setQtyKg(String(prefillQty))
  }, [prefillQty])

  async function handleSubmit() {
    if (!supplierId || !qtyKg) return
    setLoading(true)
    try {
      let res: Response
      if (mode === 'direct') {
        res = await fetch(`/api/inventory/paper-warehouse/${materialId}/direct-po`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            supplierId,
            qtyKg: Number(qtyKg),
            deliveryDate: deliveryDate || undefined,
            paymentTerms: paymentTerms || undefined,
            transportTerms: transportTerms || undefined,
            remarks: remarks || undefined,
          }),
        })
      } else {
        res = await fetch('/api/purchase-requisitions/generate-po', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prIds: [prId],
            vendorId: supplierId,
            deliveryDate: deliveryDate || undefined,
            paymentTerms: paymentTerms || undefined,
            transportTerms: transportTerms || undefined,
            remarks: remarks || undefined,
          }),
        })
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        toast.error(err.error ?? 'Failed to create PO')
        return
      }
      toast.success('Purchase order created')
      onSuccess()
      onClose()
    } finally {
      setLoading(false)
    }
  }

  const title = mode === 'from-pr' ? `Generate PO from PR` : `Fast-track PO — ${materialCode}`
  const subtitle = [boardType, gsm ? `${gsm} gsm` : null].filter(Boolean).join(' · ')

  return (
    <GlobalPopoutModal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      metadata={subtitle || undefined}
      mode="form"
      hasUnsavedChanges={!!(supplierId || qtyKg)}
      primaryAction={{ label: 'Create PO', loadingLabel: 'Creating…', onClick: handleSubmit, loading, disabled: !supplierId || !qtyKg }}
      secondaryAction={{ label: 'Cancel', onClick: onClose }}
    >
      <div className="flex flex-col gap-4">
        <div>
          <label className="mb-1 block text-xs font-semibold text-ds-ink-muted">Vendor *</label>
          <select
            value={supplierId}
            onChange={(e) => setSupplierId(e.target.value)}
            className="w-full rounded-ds-md border border-ds-line/40 bg-ds-card px-3 py-2 text-sm text-ds-ink focus:outline-none focus:ring-1 focus:ring-ds-primary"
          >
            <option value="">Select vendor…</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>{v.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-ds-ink-muted">Qty (kg) *</label>
          <input
            type="number"
            min={0}
            step="any"
            value={qtyKg}
            onChange={(e) => setQtyKg(e.target.value)}
            className="w-full rounded-ds-md border border-ds-line/40 bg-ds-card px-3 py-2 text-sm text-ds-ink focus:outline-none focus:ring-1 focus:ring-ds-primary"
            placeholder="e.g. 4200"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-ds-ink-muted">Delivery Date</label>
          <input
            type="date"
            value={deliveryDate}
            onChange={(e) => setDeliveryDate(e.target.value)}
            className="w-full rounded-ds-md border border-ds-line/40 bg-ds-card px-3 py-2 text-sm text-ds-ink focus:outline-none focus:ring-1 focus:ring-ds-primary"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-ds-ink-muted">Payment Terms</label>
          <input
            type="text"
            value={paymentTerms}
            onChange={(e) => setPaymentTerms(e.target.value)}
            className="w-full rounded-ds-md border border-ds-line/40 bg-ds-card px-3 py-2 text-sm text-ds-ink focus:outline-none focus:ring-1 focus:ring-ds-primary"
            placeholder="e.g. Net 30"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-ds-ink-muted">Transport Terms</label>
          <input
            type="text"
            value={transportTerms}
            onChange={(e) => setTransportTerms(e.target.value)}
            className="w-full rounded-ds-md border border-ds-line/40 bg-ds-card px-3 py-2 text-sm text-ds-ink focus:outline-none focus:ring-1 focus:ring-ds-primary"
            placeholder="e.g. FOB mill"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-ds-ink-muted">Remarks</label>
          <textarea
            value={remarks}
            onChange={(e) => setRemarks(e.target.value)}
            rows={2}
            className="w-full rounded-ds-md border border-ds-line/40 bg-ds-card px-3 py-2 text-sm text-ds-ink focus:outline-none focus:ring-1 focus:ring-ds-primary"
          />
        </div>
      </div>
    </GlobalPopoutModal>
  )
}
```

- [ ] **Step 2: Verify typecheck**

```bash
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add src/app/\(dashboard\)/inventory/components/DirectPoDialog.tsx
git commit -m "feat(ui): DirectPoDialog — fast-track and from-PR PO creation"
```

---

## Task 12: MaterialDrawer component

**Files:**
- Create: `src/app/(dashboard)/inventory/components/MaterialDrawer.tsx`

- [ ] **Step 1: Create the component**

```typescript
'use client'

import { useState, useEffect } from 'react'
import { GlobalPopoutModal } from '@/components/design-system/GlobalPopoutModal'
import { cn } from '@/lib/cn'
import { computeRag, ragDotClass } from '@/lib/procurement-rag'
import { computeSuggestion } from '@/lib/procurement-suggestions'
import { DirectPoDialog } from './DirectPoDialog'
import type { PaperWarehouseRow } from '../page'

type OpenPo = {
  id: string; poNumber: string; vendorName: string
  orderedKg: number; receivedKg: number; pendingKg: number
  requiredDeliveryDate: string | null; status: string; logisticsStatus: string | null
}

type Pr = {
  id: string; status: string; qtyRequired: number; requiredByDate: string | null
}

type Reservation = {
  id: string; jobCardNumber: number; productName: string; reservedSheets: number; requiredByDate: string | null
}

type Tab = 'overview' | 'reservations' | 'open-prs' | 'open-pos' | 'history'
const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'reservations', label: 'Reservations' },
  { id: 'open-prs', label: 'Open PRs' },
  { id: 'open-pos', label: 'Open POs' },
  { id: 'history', label: 'History' },
]

const nf = new Intl.NumberFormat('en-IN')

export type MaterialDrawerProps = {
  row: PaperWarehouseRow | null
  isOpen: boolean
  onClose: () => void
  onPrCreated: () => void
  onPoCreated: () => void
}

export function MaterialDrawer({ row, isOpen, onClose, onPrCreated, onPoCreated }: MaterialDrawerProps) {
  const [activeTab, setActiveTab] = useState<Tab>('overview')
  const [openPos, setOpenPos] = useState<OpenPo[]>([])
  const [openPrs, setOpenPrs] = useState<Pr[]>([])
  const [reservations, setReservations] = useState<Reservation[]>([])
  const [history, setHistory] = useState<unknown>(null)
  const [directPoTarget, setDirectPoTarget] = useState<{ prId?: string; prefillQty?: number; mode: 'direct' | 'from-pr' } | null>(null)

  // Reset on row change
  useEffect(() => {
    if (!row) return
    setActiveTab('overview')
    setOpenPos([])
    setOpenPrs([])
    setReservations([])
    setHistory(null)
  }, [row?.material_id])

  // Lazy fetch per tab
  useEffect(() => {
    if (!row || !isOpen) return
    const id = row.material_id
    if (activeTab === 'open-pos' && openPos.length === 0) {
      fetch(`/api/inventory/paper-warehouse/${id}/open-pos`)
        .then((r) => r.json()).then(setOpenPos).catch(() => {})
    }
    if (activeTab === 'open-prs' && openPrs.length === 0) {
      fetch(`/api/purchase-requisitions?materialId=${id}&status=pending,approved,ordered`)
        .then((r) => r.json()).then((d) => setOpenPrs(d.items ?? d ?? [])).catch(() => {})
    }
    if (activeTab === 'reservations' && reservations.length === 0) {
      fetch(`/api/inventory/paper-warehouse/${id}/reservations`)
        .then((r) => r.json()).then((d) => setReservations(d.reservations ?? d ?? [])).catch(() => {})
    }
    if (activeTab === 'history' && !history) {
      fetch(`/api/inventory/paper-warehouse/${id}/details`)
        .then((r) => r.json()).then(setHistory).catch(() => {})
    }
  }, [row?.material_id, activeTab, isOpen])

  if (!row) return null

  const rag = computeRag({
    shortage_sheets: Number(row.shortage_sheets),
    open_pr_id: row.open_pr_id ?? null,
    open_pr_status: row.open_pr_status ?? null,
    hasOpenPo: (row as PaperWarehouseRow & { hasOpenPo?: boolean }).hasOpenPo ?? false,
  })

  const suggestion = computeSuggestion({
    shortage_sheets: Number(row.shortage_sheets),
    incoming_sheets: Number(row.incoming_sheets),
    reorder_level: Number(row.reorder_level),
    daysOfCover: row.daysOfCover,
    packet_weight: Number(row.packet_weight),
  })

  return (
    <>
      <GlobalPopoutModal
        isOpen={isOpen}
        onClose={onClose}
        title={row.material_code}
        metadata={[row.board_type_id, row.gsm ? `${row.gsm} gsm` : null, row.size_display].filter(Boolean).join(' · ')}
        mode="preview"
        size="lg"
      >
        {/* Tab bar */}
        <div className="-mx-4 mb-4 flex gap-0 border-b border-ds-line/25 px-4 md:-mx-6 md:px-6">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setActiveTab(t.id)}
              className={cn(
                'pb-2 pr-4 text-sm font-medium transition-colors',
                activeTab === t.id
                  ? 'border-b-2 border-ds-primary text-ds-ink'
                  : 'text-ds-ink-muted hover:text-ds-ink',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Overview tab */}
        {activeTab === 'overview' && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2">
              <span className={cn('h-3 w-3 rounded-full', ragDotClass(rag))} />
              <span className="text-xs text-ds-ink-muted capitalize">{rag === 'green' ? 'Stock OK' : rag === 'amber' ? 'Shortage — being handled' : 'Shortage — action needed'}</span>
            </div>
            <div className="grid grid-cols-3 gap-3">
              {[
                { label: 'Available', value: nf.format(row.available_sheets) + ' sh' },
                { label: 'Reserved', value: nf.format(row.reserved_sheets) + ' sh' },
                { label: 'Incoming', value: nf.format(row.incoming_sheets) + ' sh' },
                { label: 'Shortage', value: nf.format(Number(row.shortage_sheets)) + ' sh' },
                { label: 'Days of Cover', value: row.daysOfCover != null ? `${row.daysOfCover}d` : '—' },
                { label: 'Reorder Level', value: nf.format(row.reorder_level) + ' sh' },
              ].map(({ label, value }) => (
                <div key={label} className="rounded-ds-md border border-ds-line/30 bg-ds-elevated/60 p-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint">{label}</div>
                  <div className="mt-0.5 font-semibold tabular-nums text-ds-ink">{value}</div>
                </div>
              ))}
            </div>
            {suggestion && (
              <div className="flex items-center justify-between rounded-ds-md border border-ds-warning/30 bg-ds-warning/5 px-4 py-3">
                <div>
                  <span className="mr-2 text-ds-warning">⚡</span>
                  <span className="text-sm font-medium text-ds-ink">
                    Suggested reorder: {nf.format(Math.round(suggestion.suggestedKg))} kg
                  </span>
                  <span className="ml-2 text-xs text-ds-ink-muted">(covers ~{suggestion.coversDays} days)</span>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={async () => {
                      await fetch(`/api/inventory/paper-warehouse/${row.material_id}/create-pr`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ qty: suggestion.suggestedKg }),
                      })
                      onPrCreated()
                    }}
                    className="rounded-ds-sm border border-ds-line/40 px-3 py-1 text-xs font-medium text-ds-ink hover:bg-ds-elevated"
                  >
                    Create PR
                  </button>
                  <button
                    type="button"
                    onClick={() => setDirectPoTarget({ mode: 'direct', prefillQty: suggestion.suggestedKg })}
                    className="rounded-ds-sm bg-ds-primary px-3 py-1 text-xs font-medium text-white hover:opacity-90"
                  >
                    Fast-track PO →
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Reservations tab */}
        {activeTab === 'reservations' && (
          <div className="flex flex-col gap-2">
            {reservations.length === 0 ? (
              <p className="text-sm text-ds-ink-muted">No reservations.</p>
            ) : (
              reservations.map((r) => (
                <div key={r.id} className="flex items-center justify-between rounded-ds-md border border-ds-line/25 px-3 py-2 text-sm">
                  <div>
                    <span className="font-medium text-ds-ink">JC-{r.jobCardNumber}</span>
                    {r.productName && <span className="ml-2 text-ds-ink-muted">{r.productName}</span>}
                  </div>
                  <div className="tabular-nums text-ds-ink">{nf.format(Number(r.reservedSheets))} sh</div>
                </div>
              ))
            )}
          </div>
        )}

        {/* Open PRs tab */}
        {activeTab === 'open-prs' && (
          <div className="flex flex-col gap-2">
            {openPrs.length === 0 ? (
              <p className="text-sm text-ds-ink-muted">No open purchase requisitions.</p>
            ) : (
              openPrs.map((pr) => (
                <div key={pr.id} className="flex items-center justify-between rounded-ds-md border border-ds-line/25 px-3 py-2 text-sm">
                  <div>
                    <span className="rounded-full bg-ds-elevated px-2 py-0.5 text-xs font-medium text-ds-ink-muted capitalize">{pr.status}</span>
                    <span className="ml-2 tabular-nums text-ds-ink">{nf.format(Number(pr.qtyRequired))} kg</span>
                    {pr.requiredByDate && (
                      <span className="ml-2 text-ds-ink-muted">{new Date(pr.requiredByDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</span>
                    )}
                  </div>
                  {(pr.status === 'approved' || pr.status === 'ordered') && (
                    <button
                      type="button"
                      onClick={() => setDirectPoTarget({ mode: 'from-pr', prId: pr.id, prefillQty: Number(pr.qtyRequired) })}
                      className="rounded-ds-sm bg-ds-primary px-3 py-1 text-xs font-medium text-white hover:opacity-90"
                    >
                      Generate PO →
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
        )}

        {/* Open POs tab */}
        {activeTab === 'open-pos' && (
          <div className="flex flex-col gap-2">
            {openPos.length === 0 ? (
              <p className="text-sm text-ds-ink-muted">No open purchase orders.</p>
            ) : (
              openPos.map((po) => {
                const pct = po.orderedKg > 0 ? (po.receivedKg / po.orderedKg) * 100 : 0
                return (
                  <div key={po.id} className="rounded-ds-md border border-ds-line/25 px-3 py-2 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-ds-ink">{po.poNumber}</span>
                      <span className="text-ds-ink-muted">{po.vendorName}</span>
                    </div>
                    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-ds-line/30">
                      <div
                        className={cn('h-full rounded-full', pct >= 100 ? 'bg-ds-success' : 'bg-ds-warning')}
                        style={{ width: `${Math.min(100, pct)}%` }}
                      />
                    </div>
                    <div className="mt-1 flex justify-between text-xs text-ds-ink-muted">
                      <span>{nf.format(Math.round(po.receivedKg))} / {nf.format(Math.round(po.orderedKg))} kg received</span>
                      {po.requiredDeliveryDate && <span>ETA {new Date(po.requiredDeliveryDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</span>}
                    </div>
                  </div>
                )
              })
            )}
          </div>
        )}

        {/* History tab */}
        {activeTab === 'history' && (
          <div className="text-sm text-ds-ink-muted">
            {!history ? 'Loading…' : <pre className="whitespace-pre-wrap text-xs">{JSON.stringify(history, null, 2)}</pre>}
          </div>
        )}
      </GlobalPopoutModal>

      {directPoTarget && (
        <DirectPoDialog
          isOpen={!!directPoTarget}
          onClose={() => setDirectPoTarget(null)}
          onSuccess={() => { setDirectPoTarget(null); onPoCreated() }}
          materialId={row.material_id}
          materialCode={row.material_code}
          boardType={row.board_type_id}
          gsm={row.gsm}
          mode={directPoTarget.mode}
          prId={directPoTarget.prId}
          prefillQty={directPoTarget.prefillQty}
        />
      )}
    </>
  )
}
```

> **Note:** The History tab renders raw JSON as a placeholder. Replace with the existing history/genealogy rendering from `inventory/page.tsx` when extracting the shell in Task 16.

- [ ] **Step 2: Verify typecheck**

```bash
npm run typecheck
```

Expected: zero errors. (Fix any import issues — `PaperWarehouseRow` export from `page.tsx` may need adding.)

- [ ] **Step 3: Commit**

```bash
git add src/app/\(dashboard\)/inventory/components/MaterialDrawer.tsx
git commit -m "feat(ui): MaterialDrawer — 5-tab unified material drawer"
```

---

## Task 13: OpenPosTab and IncomingTab components

**Files:**
- Create: `src/app/(dashboard)/inventory/components/OpenPosTab.tsx`
- Create: `src/app/(dashboard)/inventory/components/IncomingTab.tsx`

- [ ] **Step 1: Create a shared hook for open POs data**

At the top of `OpenPosTab.tsx`, define the shared hook inline (or in a separate `useOpenPos.ts` — the tab file is fine for now):

```typescript
'use client'

import { useState, useEffect } from 'react'
import { cn } from '@/lib/cn'

type OpenPoRow = {
  id: string; poNumber: string; vendorName: string; materialCode: string | null
  orderedKg: number; receivedKg: number; pendingKg: number
  requiredDeliveryDate: string | null; status: string; logisticsStatus: string | null
  daysOverdue: number | null; linkedPrIds: string[]
}

function useOpenPos() {
  const [rows, setRows] = useState<OpenPoRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    fetch('/api/inventory/paper-warehouse/open-pos')
      .then((r) => r.json())
      .then(setRows)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  return { rows, loading }
}

const nf = new Intl.NumberFormat('en-IN')

const STATUS_FILTERS = ['All', 'Dispatched', 'In Transit', 'At Gate', 'Overdue'] as const
type StatusFilter = (typeof STATUS_FILTERS)[number]

export function OpenPosTab() {
  const { rows, loading } = useOpenPos()
  const [filter, setFilter] = useState<StatusFilter>('All')
  const [search, setSearch] = useState('')

  const filtered = rows.filter((r) => {
    if (filter === 'Overdue') return (r.daysOverdue ?? 0) > 0 && r.pendingKg > 0
    if (filter === 'Dispatched') return r.logisticsStatus === 'mill_dispatched'
    if (filter === 'In Transit') return r.logisticsStatus === 'in_transit'
    if (filter === 'At Gate') return r.logisticsStatus === 'at_gate'
    return true
  }).filter((r) => {
    if (!search) return true
    const q = search.toLowerCase()
    return r.poNumber.toLowerCase().includes(q) || (r.vendorName ?? '').toLowerCase().includes(q)
  })

  if (loading) return <div className="py-8 text-center text-sm text-ds-ink-muted">Loading…</div>

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={cn(
              'rounded-full px-3 py-1 text-xs font-medium transition-colors',
              filter === f ? 'bg-ds-primary text-white' : 'border border-ds-line/40 text-ds-ink-muted hover:text-ds-ink',
            )}
          >
            {f}
          </button>
        ))}
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search PO or vendor…"
          className="ml-auto w-48 rounded-ds-md border border-ds-line/40 bg-ds-card px-3 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-ds-primary"
        />
      </div>

      {filtered.length === 0 ? (
        <p className="py-8 text-center text-sm text-ds-ink-muted">No open purchase orders.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ds-line/25 text-left text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint">
              <th className="pb-2 pr-4">PO Number</th>
              <th className="pb-2 pr-4">Vendor</th>
              <th className="pb-2 pr-4">Material</th>
              <th className="pb-2 pr-4 text-right">Ordered kg</th>
              <th className="pb-2 pr-4 text-right">Received kg</th>
              <th className="pb-2 pr-4 text-right">Pending kg</th>
              <th className="pb-2 pr-4">ETA</th>
              <th className="pb-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => {
              const isOverdue = (r.daysOverdue ?? 0) > 0 && r.pendingKg > 0
              const pct = r.orderedKg > 0 ? (r.receivedKg / r.orderedKg) * 100 : 0
              return (
                <tr
                  key={r.id}
                  className={cn(
                    'border-b border-ds-line/10',
                    isOverdue && 'bg-ds-error/5',
                  )}
                >
                  <td className="py-2 pr-4 font-medium text-ds-ink">{r.poNumber}</td>
                  <td className="py-2 pr-4 text-ds-ink-muted">{r.vendorName}</td>
                  <td className="py-2 pr-4 font-mono text-xs text-ds-ink">{r.materialCode ?? '—'}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{nf.format(Math.round(r.orderedKg))}</td>
                  <td className="py-2 pr-4 text-right">
                    <div className="flex flex-col items-end gap-0.5">
                      <span className="tabular-nums">{nf.format(Math.round(r.receivedKg))}</span>
                      <div className="h-1 w-16 overflow-hidden rounded-full bg-ds-line/30">
                        <div className={cn('h-full', pct >= 100 ? 'bg-ds-success' : 'bg-ds-warning')} style={{ width: `${Math.min(100, pct)}%` }} />
                      </div>
                    </div>
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">{nf.format(Math.round(r.pendingKg))}</td>
                  <td className={cn('py-2 pr-4', isOverdue && 'font-medium text-ds-error')}>
                    {r.requiredDeliveryDate
                      ? new Date(r.requiredDeliveryDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
                      : '—'}
                    {isOverdue && ` (+${r.daysOverdue}d)`}
                  </td>
                  <td className="py-2">
                    <span className="rounded-full bg-ds-elevated px-2 py-0.5 text-[11px] font-medium text-ds-ink-muted capitalize">
                      {r.logisticsStatus?.replace('_', ' ') ?? r.status}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Create IncomingTab.tsx**

```typescript
'use client'

import { useState, useEffect } from 'react'
import { cn } from '@/lib/cn'

type OpenPoRow = {
  id: string; poNumber: string; vendorName: string; materialCode: string | null
  orderedKg: number; receivedKg: number; pendingKg: number
  requiredDeliveryDate: string | null; status: string; logisticsStatus: string | null
  daysOverdue: number | null
}

const nf = new Intl.NumberFormat('en-IN')

function isoWeekLabel(dateStr: string): string {
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

function weekKey(dateStr: string): string {
  const d = new Date(dateStr)
  const day = d.getDay()
  const monday = new Date(d)
  monday.setDate(d.getDate() - ((day + 6) % 7))
  return monday.toISOString().slice(0, 10)
}

export function IncomingTab() {
  const [rows, setRows] = useState<OpenPoRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/inventory/paper-warehouse/open-pos')
      .then((r) => r.json())
      .then((data: OpenPoRow[]) => {
        const withDate = data
          .filter((r) => !!r.requiredDeliveryDate)
          .sort((a, b) => (a.requiredDeliveryDate! < b.requiredDeliveryDate! ? -1 : 1))
        setRows(withDate)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="py-8 text-center text-sm text-ds-ink-muted">Loading…</div>
  if (rows.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-ds-ink-muted">
        No incoming deliveries scheduled.
      </div>
    )
  }

  // Group by ISO week
  const weeks = new Map<string, OpenPoRow[]>()
  for (const r of rows) {
    const key = weekKey(r.requiredDeliveryDate!)
    const arr = weeks.get(key) ?? []
    arr.push(r)
    weeks.set(key, arr)
  }

  return (
    <div className="flex flex-col gap-6">
      {Array.from(weeks.entries()).map(([weekStart, wRows]) => {
        const totalKg = wRows.reduce((s, r) => s + r.pendingKg, 0)
        return (
          <div key={weekStart}>
            <div className="mb-2 flex items-baseline gap-2">
              <span className="text-sm font-semibold text-ds-ink">Week of {isoWeekLabel(weekStart)}</span>
              <span className="text-xs text-ds-ink-muted">
                {wRows.length} PO{wRows.length !== 1 ? 's' : ''} · {nf.format(Math.round(totalKg))} kg expected
              </span>
            </div>
            <div className="flex flex-col gap-2">
              {wRows.map((r) => {
                const isOverdue = (r.daysOverdue ?? 0) > 0
                return (
                  <div
                    key={r.id}
                    className={cn(
                      'flex items-center justify-between rounded-ds-md border border-ds-line/25 px-3 py-2',
                      isOverdue && 'border-ds-error/30 bg-ds-error/5',
                    )}
                  >
                    <div>
                      <span className="font-medium text-ds-ink">{r.vendorName}</span>
                      {r.materialCode && (
                        <span className="ml-2 font-mono text-xs text-ds-ink-muted">{r.materialCode}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="tabular-nums text-sm text-ds-ink">{nf.format(Math.round(r.pendingKg))} kg</span>
                      <span className={cn(
                        'rounded-full px-2 py-0.5 text-[11px] font-medium capitalize',
                        isOverdue ? 'bg-ds-error/10 text-ds-error' : 'bg-ds-elevated text-ds-ink-muted',
                      )}>
                        {isOverdue
                          ? `Overdue +${r.daysOverdue}d`
                          : r.logisticsStatus?.replace('_', ' ') ?? r.status}
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 3: Verify typecheck**

```bash
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add src/app/\(dashboard\)/inventory/components/OpenPosTab.tsx src/app/\(dashboard\)/inventory/components/IncomingTab.tsx
git commit -m "feat(ui): OpenPosTab and IncomingTab with GRN progress and week grouping"
```

---

## Task 14: ReportsTab component

**Files:**
- Create: `src/app/(dashboard)/inventory/components/ReportsTab.tsx`

- [ ] **Step 1: Create the component**

```typescript
'use client'

import { useState, useEffect } from 'react'

type ReportsData = {
  spendByVendor: { vendorName: string; totalInr: number; poCount: number }[]
  receiptAccuracy: { vendorName: string; orderedKg: number; receivedKg: number; accuracyPct: number }[]
  leadTimeTrend: { month: string; avgDays: number }[]
}

const nf = new Intl.NumberFormat('en-IN')

function Bar({ pct, color }: { pct: number; color: string }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-ds-line/30">
      <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(100, pct)}%` }} />
    </div>
  )
}

export function ReportsTab() {
  const [data, setData] = useState<ReportsData | null>(null)
  const [loading, setLoading] = useState(false)
  const [fetched, setFetched] = useState(false)

  useEffect(() => {
    if (fetched) return
    setFetched(true)
    setLoading(true)
    fetch('/api/inventory/paper-warehouse/reports')
      .then((r) => r.json())
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [fetched])

  if (loading) return <div className="py-8 text-center text-sm text-ds-ink-muted">Loading reports…</div>
  if (!data) return <div className="py-8 text-center text-sm text-ds-ink-muted">No data.</div>

  const maxSpend = Math.max(...data.spendByVendor.map((v) => v.totalInr), 1)

  return (
    <div className="flex flex-col gap-8">
      {/* Spend by vendor */}
      <section>
        <h3 className="mb-3 text-sm font-semibold text-ds-ink">Spend by Vendor — Last 90 days</h3>
        <div className="flex flex-col gap-2">
          {data.spendByVendor.slice(0, 8).map((v) => (
            <div key={v.vendorName}>
              <div className="mb-1 flex items-baseline justify-between text-xs">
                <span className="text-ds-ink">{v.vendorName}</span>
                <span className="tabular-nums text-ds-ink-muted">₹{nf.format(Math.round(v.totalInr / 1000))}k · {v.poCount} PO{v.poCount !== 1 ? 's' : ''}</span>
              </div>
              <Bar pct={(v.totalInr / maxSpend) * 100} color="bg-ds-primary" />
            </div>
          ))}
        </div>
      </section>

      {/* Receipt accuracy */}
      <section>
        <h3 className="mb-3 text-sm font-semibold text-ds-ink">Receipt Accuracy by Vendor</h3>
        <div className="flex flex-col gap-2">
          {data.receiptAccuracy.map((v) => (
            <div key={v.vendorName}>
              <div className="mb-1 flex items-baseline justify-between text-xs">
                <span className="text-ds-ink">{v.vendorName}</span>
                <span className={`tabular-nums font-medium ${v.accuracyPct >= 95 ? 'text-ds-success' : v.accuracyPct >= 80 ? 'text-ds-warning' : 'text-ds-error'}`}>
                  {v.accuracyPct}%
                </span>
              </div>
              <Bar pct={v.accuracyPct} color={v.accuracyPct >= 95 ? 'bg-ds-success' : v.accuracyPct >= 80 ? 'bg-ds-warning' : 'bg-ds-error'} />
            </div>
          ))}
        </div>
      </section>

      {/* Lead time trend */}
      <section>
        <h3 className="mb-3 text-sm font-semibold text-ds-ink">Avg Lead Time — Last 6 Months</h3>
        <div className="flex items-end gap-3">
          {data.leadTimeTrend.map((m) => (
            <div key={m.month} className="flex flex-1 flex-col items-center gap-1">
              <span className="text-xs font-medium tabular-nums text-ds-ink">{m.avgDays}d</span>
              <div
                className="w-full rounded-t-ds-sm bg-ds-primary/60"
                style={{ height: `${Math.max(8, m.avgDays * 2)}px` }}
              />
              <span className="text-[10px] text-ds-ink-faint">{m.month.slice(5)}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
```

- [ ] **Step 2: Verify typecheck**

```bash
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add src/app/\(dashboard\)/inventory/components/ReportsTab.tsx
git commit -m "feat(ui): ReportsTab — spend, receipt accuracy, lead time charts"
```

---

## Task 15: StockTab component

**Files:**
- Create: `src/app/(dashboard)/inventory/components/StockTab.tsx`

This is an **extraction** of the existing material inventory table from `page.tsx` plus RAG signal. The step below shows the structure — fill in the full table rendering by copying from `page.tsx` and adding RAG.

- [ ] **Step 1: Create StockTab.tsx with the table + RAG signal**

```typescript
'use client'

import { cn } from '@/lib/cn'
import { computeRag, ragBorderClass, ragDotClass } from '@/lib/procurement-rag'
import { computeSuggestion } from '@/lib/procurement-suggestions'
import type { PaperWarehouseRow } from '../page'

type Props = {
  rows: PaperWarehouseRow[]
  onRowClick: (row: PaperWarehouseRow) => void
}

const nf = new Intl.NumberFormat('en-IN')

export function StockTab({ rows, onRowClick }: Props) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-ds-line/25 text-left text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint">
            <th className="w-1 pb-2" /> {/* RAG border column */}
            <th className="pb-2 pr-4">Material</th>
            <th className="pb-2 pr-4">Board / GSM</th>
            <th className="pb-2 pr-4">Size</th>
            <th className="pb-2 pr-4 text-right">Available</th>
            <th className="pb-2 pr-4 text-right">Reserved</th>
            <th className="pb-2 pr-4 text-right">Incoming</th>
            <th className="pb-2 pr-4 text-right">Shortage</th>
            <th className="pb-2 pr-4 text-right">DoC</th>
            <th className="pb-2">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const rag = computeRag({
              shortage_sheets: Number(row.shortage_sheets),
              open_pr_id: row.open_pr_id ?? null,
              open_pr_status: row.open_pr_status ?? null,
              hasOpenPo: (row as PaperWarehouseRow & { hasOpenPo?: boolean }).hasOpenPo ?? false,
            })
            const suggestion = rag === 'red'
              ? computeSuggestion({
                  shortage_sheets: Number(row.shortage_sheets),
                  incoming_sheets: Number(row.incoming_sheets),
                  reorder_level: Number(row.reorder_level),
                  daysOfCover: row.daysOfCover,
                  packet_weight: Number(row.packet_weight),
                })
              : null

            return (
              <tr
                key={row.material_id}
                onClick={() => onRowClick(row)}
                className={cn(
                  'cursor-pointer border-b border-ds-line/10 hover:bg-ds-elevated/40',
                  ragBorderClass(rag),
                )}
              >
                <td className="py-2" /> {/* left border rendered via className */}
                <td className="py-2 pr-4 font-mono text-xs text-ds-ink">{row.material_code}</td>
                <td className="py-2 pr-4 text-ds-ink-muted">{[row.board_type_id, row.gsm ? `${row.gsm}g` : null].filter(Boolean).join(' ')}</td>
                <td className="py-2 pr-4 tabular-nums text-ds-ink-muted">{row.size_display}</td>
                <td className="py-2 pr-4 text-right tabular-nums text-ds-ink">{nf.format(Number(row.available_sheets))}</td>
                <td className="py-2 pr-4 text-right tabular-nums text-ds-ink-muted">{nf.format(Number(row.reserved_sheets))}</td>
                <td className="py-2 pr-4 text-right tabular-nums text-ds-ink-muted">{nf.format(Number(row.incoming_sheets))}</td>
                <td className={cn('py-2 pr-4 text-right tabular-nums font-medium', Number(row.shortage_sheets) > 0 ? 'text-ds-error' : 'text-ds-ink-muted')}>
                  {nf.format(Number(row.shortage_sheets))}
                </td>
                <td className="py-2 pr-4 text-right tabular-nums text-ds-ink-muted">
                  {row.daysOfCover != null ? `${row.daysOfCover}d` : '—'}
                </td>
                <td className="py-2">
                  <div className="flex items-center gap-2">
                    <span className={cn('h-2 w-2 rounded-full', ragDotClass(rag))} />
                    {suggestion && (
                      <span className="text-[11px] text-ds-warning">
                        ⚡ ~{nf.format(Math.round(suggestion.suggestedKg))} kg
                      </span>
                    )}
                  </div>
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

- [ ] **Step 2: Export `PaperWarehouseRow` type from page.tsx**

In `src/app/(dashboard)/inventory/page.tsx`, change the `PaperWarehouseRow` type declaration from `type` to `export type`:

```typescript
export type PaperWarehouseRow = {
  // ... existing fields unchanged
  hasOpenPo?: boolean   // add this new field
}
```

- [ ] **Step 3: Verify typecheck**

```bash
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add src/app/\(dashboard\)/inventory/components/StockTab.tsx src/app/\(dashboard\)/inventory/page.tsx
git commit -m "feat(ui): StockTab — extracted table with RAG signal + suggestion chip"
```

---

## Task 16: Wire the shell page

**Files:**
- Modify: `src/app/(dashboard)/inventory/page.tsx`

This is the largest task — refactoring the 2,736-line monolith to use all the new components. The steps below guide the extraction without breaking existing functionality.

- [ ] **Step 1: Add tab state using URL param `?warehouseTab=`**

Near the top of the component, add:

```typescript
const searchParams = useSearchParams()
const router = useRouter()
const activeTab = (searchParams.get('warehouseTab') ?? 'stock') as 'stock' | 'open-pos' | 'incoming' | 'reports'

function setActiveTab(tab: typeof activeTab) {
  const params = new URLSearchParams(searchParams.toString())
  params.set('warehouseTab', tab)
  router.replace(`?${params.toString()}`, { scroll: false })
}
```

- [ ] **Step 2: Replace existing KPI tiles with WarehouseKpiStrip**

Find the existing KPI tile rendering block (the row of clickable `IndustrialKpiTile` or similar components near the top of the JSX). Replace it with:

```typescript
import { WarehouseKpiStrip } from './components/WarehouseKpiStrip'
import { computeRag } from '@/lib/procurement-rag'

// Inside the component, compute rag counts from filteredRows:
const ragCounts = useMemo(() => {
  const counts = { green: 0, amber: 0, red: 0 }
  for (const row of filteredPaperWarehouseRows) {
    const rag = computeRag({
      shortage_sheets: Number(row.shortage_sheets),
      open_pr_id: row.open_pr_id ?? null,
      open_pr_status: row.open_pr_status ?? null,
      hasOpenPo: row.hasOpenPo ?? false,
    })
    counts[rag]++
  }
  return counts
}, [filteredPaperWarehouseRows])

// In JSX:
<WarehouseKpiStrip
  ragCounts={ragCounts}
  incomingKgThisWeek={/* sum pendingKg from open POs due in 7 days — pass 0 for now */}
  openPoValueInr={/* 0 for now — computed once OpenPosTab data is available */}
  avgDaysOfCover={/* mean of daysOfCover across rows */}
  onFilterRed={() => { setWarehouseKpiFilter('shortage'); setActiveTab('stock') }}
  onFilterAmber={() => { setWarehouseKpiFilter('shortage'); setActiveTab('stock') }}
  onSwitchToOpenPos={() => setActiveTab('open-pos')}
  onSwitchToIncoming={() => setActiveTab('incoming')}
/>
```

- [ ] **Step 3: Add tab navigation bar**

Below the KPI strip and above the table:

```typescript
const TABS = [
  { id: 'stock', label: 'Stock' },
  { id: 'open-pos', label: 'Open POs' },
  { id: 'incoming', label: 'Incoming' },
  { id: 'reports', label: 'Reports' },
] as const

// In JSX:
<div className="flex gap-0 border-b border-ds-line/25">
  {TABS.map((t) => (
    <button
      key={t.id}
      type="button"
      onClick={() => setActiveTab(t.id)}
      className={cn(
        'pb-2 pr-6 text-sm font-medium transition-colors',
        activeTab === t.id
          ? 'border-b-2 border-ds-primary text-ds-ink'
          : 'text-ds-ink-muted hover:text-ds-ink',
      )}
    >
      {t.label}
    </button>
  ))}
</div>
```

- [ ] **Step 4: Replace the main table with StockTab and add other tabs**

Replace the existing table JSX block:

```typescript
import { StockTab } from './components/StockTab'
import { OpenPosTab } from './components/OpenPosTab'
import { IncomingTab } from './components/IncomingTab'
import { ReportsTab } from './components/ReportsTab'

// In JSX:
{activeTab === 'stock' && (
  <StockTab
    rows={filteredPaperWarehouseRows}
    onRowClick={(row) => {
      setMaterialDrawerRow(row)
    }}
  />
)}
{activeTab === 'open-pos' && <OpenPosTab />}
{activeTab === 'incoming' && <IncomingTab />}
{activeTab === 'reports' && <ReportsTab />}
```

- [ ] **Step 5: Replace existing drawer with MaterialDrawer**

Remove the existing `SlideOverPanel` / `GlobalPopoutModal` block for the material drawer. Replace with:

```typescript
import { MaterialDrawer } from './components/MaterialDrawer'

// In JSX (near bottom):
<MaterialDrawer
  row={materialDrawerRow}
  isOpen={!!materialDrawerRow}
  onClose={() => setMaterialDrawerRow(null)}
  onPrCreated={() => { void refetchWarehouseRows() }}
  onPoCreated={() => { void refetchWarehouseRows() }}
/>
```

Remove `materialDrawerView`, `materialDrawerLoading`, `materialDrawerData` state — these now live inside `MaterialDrawer`.

- [ ] **Step 6: Run tests and typecheck**

```bash
npm run typecheck && npm test
```

Expected: zero typecheck errors, 260+ tests passing.

- [ ] **Step 7: Commit**

```bash
git add src/app/\(dashboard\)/inventory/page.tsx
git commit -m "feat(ui): wire warehouse shell — tabs, KPI strip, MaterialDrawer, StockTab"
```

---

## Task 17: Final verification

- [ ] **Step 1: Run full test suite**

```bash
npm test
```

Expected: all tests pass (260+ including the 10 new RAG + suggestion tests).

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 3: Browser verification checklist**

Start dev server (`npm run dev`), open `http://localhost:3000/inventory`.

- [ ] Stock tab renders with RAG left-borders on rows (green/amber/red)
- [ ] Red rows show `⚡ ~N kg` suggestion chip in Status column
- [ ] KPI strip shows 5 tiles; "In shortage" + "Being handled" filter the table; "Open POs" + "Incoming" switch tabs
- [ ] Open material drawer → 5 tabs load; Overview shows stock tiles + RAG badge; amber/red rows show suggestion strip with Create PR + Fast-track PO buttons
- [ ] Open PRs tab shows approved PRs with Generate PO → button
- [ ] Open POs tab in drawer shows GRN progress bar per PO
- [ ] Fast-track PO dialog: fill vendor + qty → creates PO → materialId set → appears in Open POs tab
- [ ] Generate-from-PR dialog: opens from drawer Open PRs tab → creates PO via Phase 1 endpoint → PR links via VendorPoRequisitionLink
- [ ] Open POs tab: GRN progress bars, overdue row tint, filter chips work
- [ ] Incoming tab: POs grouped by week, sorted ascending, overdue badge
- [ ] Reports tab: three charts render (spend, accuracy, lead time)
- [ ] `?warehouseTab=open-pos` URL deep-link works

- [ ] **Step 4: Commit any browser-fix patches**

```bash
git add -p   # stage only what you fixed
git commit -m "fix(warehouse): browser verification fixes"
```
