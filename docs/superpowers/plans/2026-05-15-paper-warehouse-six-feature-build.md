# Paper Warehouse + PR Kanban Six-Feature Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land six sequenced features on the paper warehouse inventory page and PR kanban: schema migration for reservation release-tracking, auto-release on job status change, clickable Reserved column slide-in panel, Days of Cover column, auto-create Draft PR on shortage, and theme overhaul.

**Architecture:** Schema-first foundation, then a shared `reservation-release.ts` helper drives both auto-release-on-status and shortage recalculation. The recalc helper calls `auto-pr-from-shortage.ts` to spawn Draft PRs. UI features (panel, Days of Cover column) read the new fields. Theme overhaul is last — token-value swap in `design-tokens.css` + a scoped hardcoded-color sweep on the two target pages.

**Tech Stack:** Next.js 14 App Router, TypeScript, Prisma 5, PostgreSQL (Neon), Tailwind CSS, Radix UI, next/font/google. Tests run as `tsx scripts/*.ts` smoke scripts (existing pattern from `material_readiness_flow_test.ts`).

---

## File Structure

### Created
- `prisma/migrations/<timestamp>_reservation_release_fields/migration.sql` (auto-generated)
- `src/lib/reservation-release.ts` — release helper + status sets
- `src/lib/auto-pr-from-shortage.ts` — draft PR creation helper
- `src/app/api/inventory/paper-warehouse/[id]/reservations/route.ts` — list reservations
- `src/app/api/inventory/reservations/[id]/release/route.ts` — manual release
- `src/app/(dashboard)/inventory/components/ReservationsPanel.tsx` — slide-in UI
- `scripts/test-reservation-release.ts` — auto-release smoke test
- `scripts/test-auto-pr-from-shortage.ts` — auto-PR dedupe smoke test
- `scripts/test-days-of-cover.ts` — DoC calculation smoke test

### Modified
- `prisma/schema.prisma` (lines 1978–2024) — add 4 fields, nullable raisedBy
- `src/lib/prisma.ts` — Prisma `$extends` middleware backstop
- `src/lib/material-readiness-service.ts` — add `computeAvgDailyConsumption`
- `src/app/api/inventory/paper-warehouse/route.ts` — include daysOfCover in response
- `src/app/(dashboard)/inventory/page.tsx` — Reserved cell, Days of Cover column, panel mount
- `src/app/(dashboard)/inventory/purchase-requisitions/page.tsx` — Draft lane + Auto badge + Promote button
- Seven job-card status mutation sites (explicit auto-release wiring)
- `src/styles/design-tokens.css` — token values
- `src/app/globals.css` — HSL vars + mono font on numeric classes
- `src/app/layout.tsx` — next/font/google for Jakarta Sans + Plex Mono
- `src/components/design-system/tokens.ts` — hex constants

---

## Phase 1: Schema Migration

### Task 1.1: Add release-tracking fields to MaterialReservation

**Files:**
- Modify: `prisma/schema.prisma:2006-2024`
- Modify: `prisma/schema.prisma:1985` (raisedBy nullable on PurchaseRequisition)

- [ ] **Step 1: Edit MaterialReservation model**

In `prisma/schema.prisma`, replace the `MaterialReservation` model body with:

```prisma
model MaterialReservation {
  id             String   @id @default(uuid())
  materialId     String   @map("material_id")
  jobCardId      String   @map("job_card_id")
  planningId     String?  @map("planning_id")
  requiredSheets Decimal  @map("required_sheets") @db.Decimal(12, 3)
  reservedSheets Decimal  @default(0) @map("reserved_sheets") @db.Decimal(12, 3)
  shortageSheets Decimal  @default(0) @map("shortage_sheets") @db.Decimal(12, 3)
  status         String   @default("draft") @db.VarChar(32)
  isReleased     Boolean  @default(false) @map("is_released")
  releasedAt     DateTime? @map("released_at")
  releasedReason String?  @map("released_reason") @db.VarChar(120)
  confirmedQty   Int?     @map("confirmed_qty")
  createdAt      DateTime @default(now()) @map("created_at")
  updatedAt      DateTime @updatedAt @map("updated_at")

  material Inventory         @relation(fields: [materialId], references: [id], onDelete: Cascade)
  jobCard  ProductionJobCard @relation(fields: [jobCardId], references: [id], onDelete: Cascade)

  @@unique([materialId, jobCardId])
  @@index([jobCardId])
  @@index([materialId, isReleased])
  @@map("material_reservations")
}
```

- [ ] **Step 2: Make `raisedBy` nullable on PurchaseRequisition**

In `prisma/schema.prisma`, find the `PurchaseRequisition` model (line ~1978). Change line ~1985 from:

```prisma
  raisedBy         String    @map("raised_by")
```

to:

```prisma
  raisedBy         String?   @map("raised_by")
```

- [ ] **Step 3: Generate the migration**

Run: `npx prisma migrate dev --name reservation_release_fields`
Expected: prompts for migration name (accept default), creates `prisma/migrations/<timestamp>_reservation_release_fields/migration.sql`, applies to local DB.

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: PASS (zero errors). If errors mention "Property 'isReleased' does not exist", `prisma generate` did not run — run `npx prisma generate` and retry.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat(schema): add release-tracking fields to MaterialReservation; make PR.raisedBy nullable

- isReleased, releasedAt, releasedReason, confirmedQty on MaterialReservation
- raisedBy nullable on PurchaseRequisition to support auto-created drafts
- new @@index([materialId, isReleased]) for fast active-only filtering"
```

---

## Phase 2: Auto-Release Helper + Wiring

### Task 2.1: Create reservation-release.ts with constants and signatures

**Files:**
- Create: `src/lib/reservation-release.ts`

- [ ] **Step 1: Write the file skeleton**

Create `src/lib/reservation-release.ts`:

```ts
import type { Prisma, PrismaClient } from '@prisma/client'

export const TERMINAL_RELEASING_STATUSES = ['cancelled', 'completed', 'on_hold'] as const
export type TerminalReleasingStatus = (typeof TERMINAL_RELEASING_STATUSES)[number]

export const ACTIVE_RESERVATION_STATUSES = [
  'design_ready',
  'ready',
  'pending_artwork',
  'artwork_approved',
  'in_production',
  'folding',
  'final_qc',
  'packing',
] as const

export function isTerminalReleasingStatus(status: string): status is TerminalReleasingStatus {
  return (TERMINAL_RELEASING_STATUSES as readonly string[]).includes(status)
}

export type ReleaseTxClient = Prisma.TransactionClient | PrismaClient

export async function releaseReservationsForJob(
  jobCardId: string,
  newStatus: TerminalReleasingStatus,
  tx: ReleaseTxClient,
): Promise<{ releasedCount: number; materialIds: string[] }> {
  throw new Error('not implemented')
}

export async function recalculateMaterialShortage(
  materialId: string,
  tx: ReleaseTxClient,
): Promise<{ shortage: number; prCreated: boolean }> {
  throw new Error('not implemented')
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/reservation-release.ts
git commit -m "feat(reservations): scaffold reservation-release helpers with status sets"
```

### Task 2.2: Write smoke test for releaseReservationsForJob

**Files:**
- Create: `scripts/test-reservation-release.ts`

- [ ] **Step 1: Write the failing smoke test**

Create `scripts/test-reservation-release.ts`:

```ts
/**
 * Smoke test: releaseReservationsForJob
 * Run: npx tsx scripts/test-reservation-release.ts
 * Asserts: when called for a job, all that job's unreleased reservations
 * are marked isReleased=true with releasedReason=`job_${status}`.
 */
import { PrismaClient } from '@prisma/client'
import { releaseReservationsForJob } from '../src/lib/reservation-release'

const prisma = new PrismaClient()

async function main() {
  // Seed: find an existing job card with at least one unreleased reservation,
  // or create a minimal one
  const existing = await prisma.materialReservation.findFirst({
    where: { isReleased: false },
    include: { jobCard: true, material: true },
  })
  if (!existing) {
    console.log('SKIP: no unreleased reservations in DB to test against')
    return
  }

  const jobCardId = existing.jobCardId
  const beforeCount = await prisma.materialReservation.count({
    where: { jobCardId, isReleased: false },
  })

  const result = await prisma.$transaction(async (tx) => {
    return releaseReservationsForJob(jobCardId, 'cancelled', tx)
  })

  console.assert(result.releasedCount === beforeCount, `releasedCount ${result.releasedCount} !== beforeCount ${beforeCount}`)
  console.assert(result.materialIds.length > 0, 'materialIds should be non-empty')

  const after = await prisma.materialReservation.findMany({ where: { jobCardId } })
  for (const r of after) {
    console.assert(r.isReleased === true, `reservation ${r.id} should be released`)
    console.assert(r.releasedReason === 'job_cancelled', `releasedReason mismatch: ${r.releasedReason}`)
    console.assert(r.releasedAt !== null, `releasedAt should be set`)
  }

  // Cleanup: revert the released rows so subsequent runs work
  await prisma.materialReservation.updateMany({
    where: { jobCardId },
    data: { isReleased: false, releasedAt: null, releasedReason: null },
  })

  console.log('PASS: releaseReservationsForJob')
}

main().catch((e) => {
  console.error('FAIL:', e)
  process.exit(1)
})
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npx tsx scripts/test-reservation-release.ts`
Expected: FAIL with `Error: not implemented`

### Task 2.3: Implement releaseReservationsForJob

**Files:**
- Modify: `src/lib/reservation-release.ts`

- [ ] **Step 1: Replace the throw with the real implementation**

In `src/lib/reservation-release.ts`, replace the body of `releaseReservationsForJob`:

```ts
export async function releaseReservationsForJob(
  jobCardId: string,
  newStatus: TerminalReleasingStatus,
  tx: ReleaseTxClient,
): Promise<{ releasedCount: number; materialIds: string[] }> {
  const targets = await tx.materialReservation.findMany({
    where: { jobCardId, isReleased: false },
    select: { id: true, materialId: true },
  })
  if (targets.length === 0) return { releasedCount: 0, materialIds: [] }

  const reason = `job_${newStatus}`
  await tx.materialReservation.updateMany({
    where: { id: { in: targets.map((t) => t.id) } },
    data: {
      isReleased: true,
      releasedAt: new Date(),
      releasedReason: reason,
    },
  })

  const materialIds = Array.from(new Set(targets.map((t) => t.materialId)))
  return { releasedCount: targets.length, materialIds }
}
```

- [ ] **Step 2: Run the smoke test — expect PASS**

Run: `npx tsx scripts/test-reservation-release.ts`
Expected: `PASS: releaseReservationsForJob`

- [ ] **Step 3: Verify TS compiles**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/reservation-release.ts scripts/test-reservation-release.ts
git commit -m "feat(reservations): implement releaseReservationsForJob with idempotent update"
```

### Task 2.4: Write smoke test for recalculateMaterialShortage

**Files:**
- Modify: `scripts/test-reservation-release.ts`

- [ ] **Step 1: Append the second test**

Append to `scripts/test-reservation-release.ts` (after the existing `main()` body, refactor into a `testRelease()` function and add a `testRecalc()` function called from `main()`):

```ts
async function testRecalc() {
  const existing = await prisma.materialReservation.findFirst({
    where: { isReleased: false },
    include: { jobCard: true },
  })
  if (!existing) {
    console.log('SKIP testRecalc: no unreleased reservations')
    return
  }

  const { recalculateMaterialShortage } = await import('../src/lib/reservation-release')

  const result = await prisma.$transaction(async (tx) => {
    return recalculateMaterialShortage(existing.materialId, tx)
  })

  console.assert(typeof result.shortage === 'number', `shortage should be a number, got ${typeof result.shortage}`)
  console.assert(result.shortage >= 0, `shortage should be non-negative, got ${result.shortage}`)

  // Hand-compute expected and compare
  const active = await prisma.materialReservation.findMany({
    where: {
      materialId: existing.materialId,
      isReleased: false,
      jobCard: {
        status: {
          in: [
            'design_ready', 'ready', 'pending_artwork', 'artwork_approved',
            'in_production', 'folding', 'final_qc', 'packing',
          ],
        },
      },
    },
  })
  const expected = active.reduce((sum, r) =>
    sum + Math.max(0, Number(r.requiredSheets) - Number(r.reservedSheets)), 0)
  console.assert(Math.abs(result.shortage - expected) < 0.01,
    `shortage mismatch: got ${result.shortage}, expected ${expected}`)

  console.log('PASS: recalculateMaterialShortage')
}
```

Update `main()`:

```ts
async function main() {
  await testRelease()
  await testRecalc()
}
```

(Rename the existing test body to `testRelease()`.)

- [ ] **Step 2: Run it — expect FAIL on recalc**

Run: `npx tsx scripts/test-reservation-release.ts`
Expected: testRelease PASS, testRecalc FAIL with `Error: not implemented`

### Task 2.5: Implement recalculateMaterialShortage

**Files:**
- Modify: `src/lib/reservation-release.ts`

- [ ] **Step 1: Replace the throw with the real implementation**

In `src/lib/reservation-release.ts`, replace the body of `recalculateMaterialShortage`:

```ts
export async function recalculateMaterialShortage(
  materialId: string,
  tx: ReleaseTxClient,
): Promise<{ shortage: number; prCreated: boolean }> {
  const active = await tx.materialReservation.findMany({
    where: {
      materialId,
      isReleased: false,
      jobCard: {
        status: { in: ACTIVE_RESERVATION_STATUSES as unknown as string[] },
      },
    },
    select: { requiredSheets: true, reservedSheets: true },
  })

  const shortage = active.reduce(
    (sum, r) => sum + Math.max(0, Number(r.requiredSheets) - Number(r.reservedSheets)),
    0,
  )

  // Phase 5 will hook auto-PR creation here. For now, return prCreated=false.
  return { shortage, prCreated: false }
}
```

- [ ] **Step 2: Run the smoke test — expect PASS**

Run: `npx tsx scripts/test-reservation-release.ts`
Expected: both tests PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/reservation-release.ts scripts/test-reservation-release.ts
git commit -m "feat(reservations): implement recalculateMaterialShortage filtering on active job statuses"
```

### Task 2.6: Add Prisma middleware backstop

**Files:**
- Modify: `src/lib/prisma.ts`

- [ ] **Step 1: Find the prisma client file**

Run: `cat src/lib/prisma.ts`
Note: if the file does not exist, search with `find src -name "prisma.ts" -o -name "db.ts" | head`. Confirm where the singleton PrismaClient is exported.

- [ ] **Step 2: Add the `$extends` middleware**

In `src/lib/prisma.ts`, wrap the exported prisma client with `.$extends({ query: { productionJobCard: { ... } } })`. The pattern:

```ts
import { PrismaClient } from '@prisma/client'
import { isTerminalReleasingStatus, releaseReservationsForJob, recalculateMaterialShortage } from './reservation-release'

const base = new PrismaClient()

export const prisma = base.$extends({
  query: {
    productionJobCard: {
      async update({ args, query }) {
        const newStatus = (args.data as { status?: unknown }).status
        if (typeof newStatus === 'string' && isTerminalReleasingStatus(newStatus)) {
          const jobCardId = (args.where as { id?: string }).id
          if (jobCardId) {
            // Run in same tx implicitly via base client (no nested $transaction)
            const { materialIds } = await releaseReservationsForJob(jobCardId, newStatus, base)
            for (const mid of materialIds) {
              await recalculateMaterialShortage(mid, base)
            }
          }
        }
        return query(args)
      },
      async updateMany({ args, query }) {
        const newStatus = (args.data as { status?: unknown }).status
        if (typeof newStatus === 'string' && isTerminalReleasingStatus(newStatus)) {
          // updateMany: find affected jobCardIds first
          const affected = await base.productionJobCard.findMany({
            where: args.where,
            select: { id: true },
          })
          for (const { id } of affected) {
            const { materialIds } = await releaseReservationsForJob(id, newStatus, base)
            for (const mid of materialIds) {
              await recalculateMaterialShortage(mid, base)
            }
          }
        }
        return query(args)
      },
    },
  },
})
```

If the existing `prisma.ts` already extends with other clients, merge the `query.productionJobCard` block into the existing extension rather than re-declaring.

- [ ] **Step 3: Verify TS compiles**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Run reservation-release smoke test again — must still PASS**

Run: `npx tsx scripts/test-reservation-release.ts`
Expected: both tests PASS. The middleware should NOT trigger here because we're calling `releaseReservationsForJob` directly inside a tx, not through `productionJobCard.update`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/prisma.ts
git commit -m "feat(reservations): add Prisma \$extends middleware backstop for auto-release

When productionJobCard.update sets status to cancelled/completed/on_hold,
auto-fire releaseReservationsForJob + recalc. Idempotent — relies on
isReleased filter so duplicate calls from explicit wiring are no-ops."
```

### Task 2.7: Wire explicit auto-release calls at the seven status-mutation sites

The middleware backstop catches anything, but explicit calls are visible in code review and don't depend on Prisma internals. Wire each site.

**Files (all confirmed to mutate ProductionJobCard.status):**
- Modify: `src/app/api/job-cards/[id]/route.ts`
- Modify: `src/app/api/job-cards/clear-queue/route.ts`
- Modify: `src/app/api/sheet-issues/job-card-issue/route.ts`
- Modify: `src/app/api/dispatch/route.ts`
- Modify: `src/app/api/tooling-hub/unified-dispatch/route.ts`
- Modify: `src/app/api/production/stages/[stageKey]/triage/route.ts`
- Modify: `src/app/api/production/stages/[stageKey]/controls/route.ts`

- [ ] **Step 1: Wire `src/app/api/job-cards/[id]/route.ts`**

Open the file and find every `prisma.productionJobCard.update(...)` call with `status:` in `data`. For each, if the new status is statically `'cancelled'`, `'completed'`, or `'on_hold'`, wrap the update in `prisma.$transaction` and call the helpers. If the new status is dynamic (from req body), branch:

```ts
import { isTerminalReleasingStatus, releaseReservationsForJob, recalculateMaterialShortage } from '@/lib/reservation-release'

// Replace:
//   const updated = await prisma.productionJobCard.update({ where: { id }, data: { status: newStatus } })
// With:
const updated = await prisma.$transaction(async (tx) => {
  const u = await tx.productionJobCard.update({ where: { id }, data: { status: newStatus } })
  if (isTerminalReleasingStatus(newStatus)) {
    const { materialIds } = await releaseReservationsForJob(id, newStatus, tx)
    for (const mid of materialIds) {
      await recalculateMaterialShortage(mid, tx)
    }
  }
  return u
})
```

The middleware is the backstop — if you forget a site, behavior is still correct. The explicit wrap exists so reviewers see the contract.

- [ ] **Step 2: Repeat for the other six files**

For each of:
- `src/app/api/job-cards/clear-queue/route.ts`
- `src/app/api/sheet-issues/job-card-issue/route.ts`
- `src/app/api/dispatch/route.ts`
- `src/app/api/tooling-hub/unified-dispatch/route.ts`
- `src/app/api/production/stages/[stageKey]/triage/route.ts`
- `src/app/api/production/stages/[stageKey]/controls/route.ts`

Apply the same wrap pattern at each `productionJobCard.update` site that mutates `status`. If a site's update is already inside a `$transaction`, just inject the helper calls inside the existing tx callback.

- [ ] **Step 3: Verify TS compiles**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/
git commit -m "feat(reservations): explicit auto-release wiring at 7 job-card status sites

Backstop middleware in src/lib/prisma.ts catches missed sites; explicit
calls here document the contract and survive Prisma upgrades."
```

### Task 2.8: End-to-end integration smoke test

**Files:**
- Create (extension): `scripts/test-reservation-release.ts` already exists — add a third test

- [ ] **Step 1: Add `testEndToEnd` to the script**

Append to `scripts/test-reservation-release.ts`:

```ts
async function testEndToEnd() {
  // Find a job card NOT in terminal state with at least one unreleased reservation
  const existing = await prisma.materialReservation.findFirst({
    where: {
      isReleased: false,
      jobCard: {
        status: {
          in: [
            'design_ready', 'ready', 'pending_artwork', 'artwork_approved',
            'in_production', 'folding', 'final_qc', 'packing',
          ],
        },
      },
    },
    include: { jobCard: true },
  })
  if (!existing) {
    console.log('SKIP testEndToEnd: no active job with reservations')
    return
  }

  const originalStatus = existing.jobCard.status
  const jobCardId = existing.jobCardId

  // Call .update through the extended prisma client
  await prisma.productionJobCard.update({
    where: { id: jobCardId },
    data: { status: 'cancelled' },
  })

  const after = await prisma.materialReservation.findMany({ where: { jobCardId } })
  for (const r of after) {
    console.assert(r.isReleased === true, `reservation ${r.id} should be released by middleware`)
    console.assert(r.releasedReason === 'job_cancelled', `releasedReason should be job_cancelled, got ${r.releasedReason}`)
  }

  // Revert
  await prisma.materialReservation.updateMany({
    where: { jobCardId },
    data: { isReleased: false, releasedAt: null, releasedReason: null },
  })
  await prisma.productionJobCard.update({
    where: { id: jobCardId },
    data: { status: originalStatus },
  })

  console.log('PASS: testEndToEnd (middleware auto-release)')
}
```

Add `await testEndToEnd()` to `main()`.

- [ ] **Step 2: Run all tests**

Run: `npx tsx scripts/test-reservation-release.ts`
Expected: all three tests PASS.

- [ ] **Step 3: Commit**

```bash
git add scripts/test-reservation-release.ts
git commit -m "test(reservations): end-to-end middleware auto-release smoke test"
```

---

## Phase 3: Reserved-Column Slide-in Panel

### Task 3.1: Create the reservations list API route

**Files:**
- Create: `src/app/api/inventory/paper-warehouse/[id]/reservations/route.ts`

- [ ] **Step 1: Write the route handler**

Create `src/app/api/inventory/paper-warehouse/[id]/reservations/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

const TERMINAL_STATUSES = ['cancelled', 'completed', 'on_hold', 'archived']

export async function GET(
  request: Request,
  { params }: { params: { id: string } },
) {
  const materialId = params.id
  const url = new URL(request.url)
  const includeReleased = url.searchParams.get('includeReleased') === 'true'

  const material = await prisma.inventory.findUnique({
    where: { id: materialId },
    select: { id: true, code: true, boardType: true, gsm: true, sizeLabel: true, grainDirection: true },
  })
  if (!material) return NextResponse.json({ error: 'Material not found' }, { status: 404 })

  const reservations = await prisma.materialReservation.findMany({
    where: {
      materialId,
      ...(includeReleased ? {} : { isReleased: false }),
    },
    include: {
      jobCard: {
        select: {
          id: true,
          jobCardNumber: true,
          status: true,
          customer: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  })

  const rows = reservations.map((r) => {
    const isGhost = !r.isReleased && TERMINAL_STATUSES.includes(r.jobCard.status)
    return {
      id: r.id,
      jobCardId: r.jobCardId,
      jobCardNumber: r.jobCard.jobCardNumber,
      customerName: r.jobCard.customer.name,
      jobStatus: r.jobCard.status,
      requiredSheets: Number(r.requiredSheets),
      reservedSheets: Number(r.reservedSheets),
      confirmedQty: r.confirmedQty,
      isReleased: r.isReleased,
      releasedAt: r.releasedAt?.toISOString() ?? null,
      releasedReason: r.releasedReason,
      isGhost,
      createdAt: r.createdAt.toISOString(),
    }
  })

  // Ghosts first (oldest first), then active (newest first)
  rows.sort((a, b) => {
    if (a.isGhost !== b.isGhost) return a.isGhost ? -1 : 1
    if (a.isGhost) return a.createdAt.localeCompare(b.createdAt)
    return b.createdAt.localeCompare(a.createdAt)
  })

  const ghostCount = rows.filter((r) => r.isGhost).length
  const totalReserved = rows.reduce((s, r) => s + r.reservedSheets, 0)

  return NextResponse.json({
    materialId: material.id,
    materialCode: material.code,
    materialSpec: {
      boardType: material.boardType,
      gsm: material.gsm,
      sizeLabel: material.sizeLabel,
      grainDirection: material.grainDirection,
    },
    totalReserved,
    ghostCount,
    reservations: rows,
  })
}
```

- [ ] **Step 2: Verify TS compiles**

Run: `npx tsc --noEmit`
Expected: PASS. If `Inventory` lacks one of the selected fields, adjust the select list — pull from the actual model definition.

- [ ] **Step 3: Manual smoke check**

Run: `npm run dev` in another terminal. Then:
```bash
curl http://localhost:3000/api/inventory/paper-warehouse/<some-material-id>/reservations | jq
```
Pick a material id from the database that has reservations. Expected: JSON with `reservations` array, sorted with ghosts first.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/inventory/paper-warehouse/[id]/reservations/route.ts
git commit -m "feat(api): list reservations for a material with ghost flagging"
```

### Task 3.2: Create the manual release API route

**Files:**
- Create: `src/app/api/inventory/reservations/[id]/release/route.ts`

- [ ] **Step 1: Write the route handler**

Create `src/app/api/inventory/reservations/[id]/release/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { recalculateMaterialShortage } from '@/lib/reservation-release'

const Body = z.object({ reason: z.string().min(3).max(120) })

export async function POST(
  request: Request,
  { params }: { params: { id: string } },
) {
  const reservationId = params.id
  const parsed = Body.safeParse(await request.json())
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body', issues: parsed.error.issues }, { status: 400 })
  }

  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.materialReservation.findUnique({
      where: { id: reservationId },
      select: { id: true, isReleased: true, materialId: true },
    })
    if (!existing) return { error: 'not_found' as const }
    if (existing.isReleased) return { error: 'already_released' as const }

    const updated = await tx.materialReservation.update({
      where: { id: reservationId },
      data: {
        isReleased: true,
        releasedAt: new Date(),
        releasedReason: parsed.data.reason,
      },
    })

    const recalc = await recalculateMaterialShortage(existing.materialId, tx)
    return { updated, shortage: recalc.shortage }
  })

  if ('error' in result) {
    return NextResponse.json({ error: result.error }, { status: result.error === 'not_found' ? 404 : 409 })
  }

  return NextResponse.json({ ok: true, reservationId: result.updated.id, shortage: result.shortage })
}
```

- [ ] **Step 2: Verify TS compiles**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Manual smoke check**

```bash
curl -X POST http://localhost:3000/api/inventory/reservations/<some-reservation-id>/release \
  -H "Content-Type: application/json" \
  -d '{"reason":"manual smoke test"}' | jq
```
Expected: `{ ok: true, ... }`. Re-running the same call should return `{ error: 'already_released' }` with 409.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/inventory/reservations/[id]/release/route.ts
git commit -m "feat(api): manual reservation release endpoint with shortage recalc"
```

### Task 3.3: Build the ReservationsPanel component

**Files:**
- Create: `src/app/(dashboard)/inventory/components/ReservationsPanel.tsx`

- [ ] **Step 1: Identify the Sheet/Drawer primitive used elsewhere**

Run: `find src/components -name "sheet.tsx" -o -name "drawer.tsx"`
Expected output identifies the existing primitive. If `src/components/ui/sheet.tsx` exists, use that (Radix-based shadcn pattern). If not, fall back to a simple `<dialog>` element with Tailwind transforms.

- [ ] **Step 2: Write the component**

Create `src/app/(dashboard)/inventory/components/ReservationsPanel.tsx`:

```tsx
'use client'

import { useEffect, useState } from 'react'
import { ChevronRight, AlertTriangle, ExternalLink, X } from 'lucide-react'
import { toast } from 'sonner'

type ReservationRow = {
  id: string
  jobCardId: string
  jobCardNumber: number
  customerName: string
  jobStatus: string
  requiredSheets: number
  reservedSheets: number
  isReleased: boolean
  isGhost: boolean
  createdAt: string
}

type PanelData = {
  materialId: string
  materialCode: string
  materialSpec: { boardType: string | null; gsm: number | null; sizeLabel: string | null; grainDirection: string | null }
  totalReserved: number
  ghostCount: number
  reservations: ReservationRow[]
}

export function ReservationsPanel({
  materialId,
  open,
  onClose,
  onRefresh,
}: {
  materialId: string | null
  open: boolean
  onClose: () => void
  onRefresh?: () => void
}) {
  const [data, setData] = useState<PanelData | null>(null)
  const [loading, setLoading] = useState(false)
  const [releasingId, setReleasingId] = useState<string | null>(null)
  const [activeReleaseReason, setActiveReleaseReason] = useState('')

  useEffect(() => {
    if (!open || !materialId) return
    setLoading(true)
    fetch(`/api/inventory/paper-warehouse/${materialId}/reservations`)
      .then((r) => r.json())
      .then((d) => setData(d))
      .finally(() => setLoading(false))
  }, [open, materialId])

  async function releaseGhost(id: string) {
    setReleasingId(id)
    try {
      const res = await fetch(`/api/inventory/reservations/${id}/release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'manual_ghost_backfill' }),
      })
      if (!res.ok) throw new Error('Release failed')
      toast.success('Ghost reservation released')
      // refresh
      const r = await fetch(`/api/inventory/paper-warehouse/${materialId}/reservations`)
      setData(await r.json())
      onRefresh?.()
    } catch (e) {
      toast.error(String(e))
    } finally {
      setReleasingId(null)
    }
  }

  async function releaseActive(id: string) {
    if (activeReleaseReason.trim().length < 3) {
      toast.error('Reason must be at least 3 characters')
      return
    }
    setReleasingId(id)
    try {
      const res = await fetch(`/api/inventory/reservations/${id}/release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: activeReleaseReason }),
      })
      if (!res.ok) throw new Error('Release failed')
      toast.success('Reservation released')
      setActiveReleaseReason('')
      const r = await fetch(`/api/inventory/paper-warehouse/${materialId}/reservations`)
      setData(await r.json())
      onRefresh?.()
    } catch (e) {
      toast.error(String(e))
    } finally {
      setReleasingId(null)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <aside
        className="relative h-full w-[480px] bg-[var(--bg-card)] shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between px-4 py-3 border-b border-ds-line/60">
          <div>
            <div className="text-[14px] font-semibold text-ds-ink">{data?.materialCode ?? '—'}</div>
            <div className="text-[12px] text-ds-ink-muted">
              {data?.materialSpec.boardType} · {data?.materialSpec.gsm}gsm · {data?.materialSpec.sizeLabel}
            </div>
          </div>
          <button onClick={onClose} className="p-1 text-ds-ink-muted hover:text-ds-ink"><X size={18} /></button>
        </header>

        <div className="px-4 py-2 border-b border-ds-line/60">
          <span className="text-[11px] uppercase tracking-wider text-ds-ink-muted">Total Reserved</span>
          <div className="text-[20px] font-bold tabular-nums">{data?.totalReserved ?? 0}</div>
        </div>

        {data && data.ghostCount > 0 && (
          <div className="m-3 p-3 rounded border border-ds-danger/40 bg-ds-danger/10 text-[13px] text-ds-danger flex gap-2">
            <AlertTriangle size={16} />
            <div>
              <strong>{data.ghostCount} ghost reservation{data.ghostCount === 1 ? '' : 's'}</strong>
              <div className="text-[12px] opacity-80">Jobs are terminal but reservations weren't auto-released. Click Release to clean up.</div>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
          {loading && <div className="text-center text-ds-ink-muted py-8">Loading…</div>}
          {!loading && data?.reservations.length === 0 && (
            <div className="text-center text-ds-ink-muted py-8">No active reservations on this material</div>
          )}
          {data?.reservations.map((r) => (
            <div
              key={r.id}
              className={`rounded border p-3 ${r.isGhost ? 'border-l-4 border-l-ds-danger border-ds-danger/30 bg-ds-danger/5' : 'border-l-4 border-l-ds-line border-ds-line/40 bg-[var(--bg-elevated)]'}`}
            >
              <div className="flex items-center justify-between mb-1">
                <div className="font-semibold text-ds-ink">Job #{r.jobCardNumber}</div>
                <a href={`/production/job-cards/${r.jobCardId}`} className="text-ds-ink-muted hover:text-ds-brand">
                  <ExternalLink size={14} />
                </a>
              </div>
              <div className="text-[12px] text-ds-ink-muted">{r.customerName}</div>
              <div className="flex items-center justify-between mt-2">
                <span className={`text-[11px] px-2 py-0.5 rounded ${r.isGhost ? 'bg-ds-danger/20 text-ds-danger' : 'bg-ds-line/30 text-ds-ink-muted'}`}>
                  {r.jobStatus}
                </span>
                <span className="text-[12px] tabular-nums text-ds-ink">
                  {r.reservedSheets} / {r.requiredSheets}
                </span>
              </div>
              {r.isGhost ? (
                <button
                  onClick={() => releaseGhost(r.id)}
                  disabled={releasingId === r.id}
                  className="mt-2 w-full rounded bg-ds-danger text-white text-[12px] py-1.5 font-medium disabled:opacity-50"
                >
                  {releasingId === r.id ? 'Releasing…' : 'Release'}
                </button>
              ) : (
                <div className="mt-2 flex gap-2">
                  <input
                    type="text"
                    placeholder="Reallocating to higher-priority job"
                    value={activeReleaseReason}
                    onChange={(e) => setActiveReleaseReason(e.target.value)}
                    className="ds-input h-7 text-[11px] flex-1"
                  />
                  <button
                    onClick={() => releaseActive(r.id)}
                    disabled={releasingId === r.id}
                    className="rounded border border-ds-line text-ds-ink text-[12px] px-3 py-1 hover:bg-ds-elevated disabled:opacity-50"
                  >
                    Release
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </aside>
    </div>
  )
}
```

- [ ] **Step 3: Verify TS compiles**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/app/(dashboard)/inventory/components/ReservationsPanel.tsx
git commit -m "feat(ui): ReservationsPanel slide-in with ghost flagging + manual release"
```

### Task 3.4: Wire panel into paper-warehouse page

**Files:**
- Modify: `src/app/(dashboard)/inventory/page.tsx`

- [ ] **Step 1: Import the panel and add state**

Open `src/app/(dashboard)/inventory/page.tsx`. Near other imports at top, add:

```ts
import { ReservationsPanel } from './components/ReservationsPanel'
```

Find the existing state block (around line 200–250 where `materialDrawerRow` is declared). Add:

```ts
const [reservationsPanelMaterialId, setReservationsPanelMaterialId] = useState<string | null>(null)
```

- [ ] **Step 2: Make the Reserved cell clickable**

In the table body (search for `qtyReserved` rendering), wrap the cell value in a button:

```tsx
<td className="px-3 py-2 text-right tabular-nums">
  {row.qtyReserved > 0 ? (
    <button
      onClick={() => setReservationsPanelMaterialId(row.material_id)}
      className="inline-flex items-center gap-1 underline-offset-2 hover:underline hover:text-ds-brand"
    >
      {fmt(row.qtyReserved)}
      <ChevronRight size={12} />
    </button>
  ) : (
    <span className="text-ds-ink-muted">{fmt(row.qtyReserved)}</span>
  )}
</td>
```

Add `import { ChevronRight } from 'lucide-react'` if not already imported.

- [ ] **Step 3: Mount the panel at the end of the page JSX**

Just before the closing tag of the page's root element, add:

```tsx
<ReservationsPanel
  materialId={reservationsPanelMaterialId}
  open={reservationsPanelMaterialId !== null}
  onClose={() => setReservationsPanelMaterialId(null)}
  onRefresh={() => loadPaperWarehouse('')}
/>
```

- [ ] **Step 4: Run dev server + manual smoke**

Run: `npm run dev`
In the browser, navigate to `/inventory`. Find a row with `Reserved > 0`. Click the cell.
Expected: panel slides in from right, shows reservations for that material.

- [ ] **Step 5: Verify TS compiles**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/(dashboard)/inventory/page.tsx
git commit -m "feat(ui): make Reserved column clickable → ReservationsPanel slide-in"
```

---

## Phase 4: Days of Cover Column

### Task 4.1: Add computeAvgDailyConsumption to material-readiness-service

**Files:**
- Modify: `src/lib/material-readiness-service.ts`

- [ ] **Step 1: Inspect the file**

Run: `head -40 src/lib/material-readiness-service.ts`
Note the exports and the pattern in use (function vs. class).

- [ ] **Step 2: Append the function**

Add to `src/lib/material-readiness-service.ts`:

```ts
import { subDays } from 'date-fns'

/**
 * Returns avg daily consumption per material, computed from SheetIssueRecord
 * rows on completed job cards in the last 30 days.
 */
export async function computeAvgDailyConsumption(
  materialIds: string[],
): Promise<Map<string, number>> {
  if (materialIds.length === 0) return new Map()

  const thirtyDaysAgo = subDays(new Date(), 30)

  // Pull all SheetIssueRecord rows in window where the parent job is completed
  // AND its allocated paper warehouse maps to one of the materials we want.
  // Join: SheetIssueRecord -> jobCard -> allocatedPaperWarehouse -> (board/gsm spec) -> Inventory.id
  //
  // For now we materialize the join via Prisma and aggregate in memory; if perf
  // becomes a problem, replace with a raw SQL groupBy.
  const records = await prisma.sheetIssueRecord.findMany({
    where: {
      issuedAt: { gte: thirtyDaysAgo },
      jobCard: {
        status: 'completed',
        allocatedPaperWarehouseId: { not: null },
      },
    },
    select: {
      qtyRequested: true,
      jobCard: {
        select: {
          allocatedPaperWarehouse: {
            select: { paperType: true, gsm: true, sheetSizeLabel: true },
          },
        },
      },
    },
  })

  // Build spec → materialId lookup once
  const materials = await prisma.inventory.findMany({
    where: { id: { in: materialIds } },
    select: { id: true, boardType: true, gsm: true, sizeLabel: true },
  })
  const specToMaterial = new Map<string, string>()
  for (const m of materials) {
    const key = `${m.boardType ?? ''}|${m.gsm ?? ''}|${m.sizeLabel ?? ''}`
    specToMaterial.set(key, m.id)
  }

  // Aggregate
  const totals = new Map<string, number>()
  for (const r of records) {
    const wh = r.jobCard?.allocatedPaperWarehouse
    if (!wh) continue
    const key = `${wh.paperType}|${wh.gsm}|${wh.sheetSizeLabel ?? ''}`
    const materialId = specToMaterial.get(key)
    if (!materialId) continue
    totals.set(materialId, (totals.get(materialId) ?? 0) + r.qtyRequested)
  }

  const avgPerDay = new Map<string, number>()
  for (const [mid, total] of totals) {
    avgPerDay.set(mid, total / 30)
  }
  return avgPerDay
}
```

Make sure `prisma` is imported at the top of the file. Adjust the spec key composition if the existing material ↔ paper-warehouse join in the codebase uses different fields (search for `allocatedPaperWarehouse` in the codebase to confirm the join shape).

- [ ] **Step 3: Verify TS compiles**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/material-readiness-service.ts
git commit -m "feat(inventory): computeAvgDailyConsumption from SheetIssueRecord on completed jobs"
```

### Task 4.2: Smoke test the calculation

**Files:**
- Create: `scripts/test-days-of-cover.ts`

- [ ] **Step 1: Write the smoke test**

Create `scripts/test-days-of-cover.ts`:

```ts
/**
 * Smoke test: computeAvgDailyConsumption + daysOfCover band.
 * Run: npx tsx scripts/test-days-of-cover.ts
 */
import { PrismaClient } from '@prisma/client'
import { computeAvgDailyConsumption } from '../src/lib/material-readiness-service'

const prisma = new PrismaClient()

async function main() {
  const materials = await prisma.inventory.findMany({ select: { id: true }, take: 20 })
  const ids = materials.map((m) => m.id)
  const result = await computeAvgDailyConsumption(ids)

  console.log(`Computed consumption for ${result.size} of ${ids.length} materials`)
  for (const [mid, avg] of result) {
    console.assert(avg >= 0, `avg should be non-negative for ${mid}`)
  }

  if (result.size > 0) {
    console.log('Sample:', Array.from(result.entries()).slice(0, 3))
  }
  console.log('PASS: computeAvgDailyConsumption')
}

main().catch((e) => {
  console.error('FAIL:', e)
  process.exit(1)
})
```

- [ ] **Step 2: Run it — expect PASS**

Run: `npx tsx scripts/test-days-of-cover.ts`
Expected: `PASS: computeAvgDailyConsumption`. If `result.size === 0`, that's acceptable — means no completed-job activity in last 30 days for the sampled materials.

- [ ] **Step 3: Commit**

```bash
git add scripts/test-days-of-cover.ts
git commit -m "test(inventory): smoke test computeAvgDailyConsumption"
```

### Task 4.3: Extend paper-warehouse list API to include daysOfCover

**Files:**
- Modify: `src/app/api/inventory/paper-warehouse/route.ts`

- [ ] **Step 1: Read the existing route**

Run: `cat src/app/api/inventory/paper-warehouse/route.ts | head -100`
Note the existing response shape — find where `rows` are constructed.

- [ ] **Step 2: Compute and attach daysOfCover**

Near the end of the GET handler, after `rows` is built, before returning:

```ts
import { computeAvgDailyConsumption } from '@/lib/material-readiness-service'

// ...
const materialIds = rows.map((r) => r.material_id).filter(Boolean)
const consumption = await computeAvgDailyConsumption(materialIds)
const rowsWithDoC = rows.map((r) => {
  const avg = consumption.get(r.material_id) ?? 0
  return {
    ...r,
    daysOfCover: avg > 0 ? Math.floor((r.freeStock ?? 0) / avg) : null,
  }
})

return NextResponse.json({ rows: rowsWithDoC, kpi: /* existing kpi */ })
```

Adjust to match the existing response shape exactly — preserve all existing fields.

- [ ] **Step 3: Verify TS compiles and smoke**

Run: `npx tsc --noEmit`
Run: `curl http://localhost:3000/api/inventory/paper-warehouse | jq '.rows[0] | keys'`
Expected: includes `daysOfCover`.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/inventory/paper-warehouse/route.ts
git commit -m "feat(api): include daysOfCover on paper-warehouse list response"
```

### Task 4.4: Add Days of Cover column to the UI

**Files:**
- Modify: `src/app/(dashboard)/inventory/page.tsx`

- [ ] **Step 1: Extend the row type**

Find `type PaperWarehouseRow = {` (line ~38). Add:

```ts
  daysOfCover: number | null
```

- [ ] **Step 2: Add the column header**

Find the table header row (line ~1163, the `<thead>`). After the "Free Stock" `<th>`, add:

```tsx
<th className="px-3 py-2 text-right">Days of Cover</th>
```

- [ ] **Step 3: Add the cell renderer**

In the table body's row rendering, after the Free Stock cell, add:

```tsx
<td className="px-3 py-2 text-right">
  {row.daysOfCover === null ? (
    <span className="text-ds-ink-muted" title="No completed-job consumption in last 30 days">—</span>
  ) : (
    <span
      className={`inline-block px-2 py-0.5 rounded text-[11px] font-semibold tabular-nums ${
        row.daysOfCover < 7
          ? 'bg-ds-danger/15 text-ds-danger'
          : row.daysOfCover < 30
          ? 'bg-ds-warning/15 text-ds-warning'
          : 'bg-ds-success/15 text-ds-success'
      }`}
    >
      {row.daysOfCover}d
    </span>
  )}
</td>
```

- [ ] **Step 4: Run dev and verify**

Run: `npm run dev`
In the browser, navigate to `/inventory`. Confirm the Days of Cover column renders with correct colors.

- [ ] **Step 5: Commit**

```bash
git add src/app/(dashboard)/inventory/page.tsx
git commit -m "feat(ui): Days of Cover column with red/yellow/green thresholds"
```

---

## Phase 5: Auto-Create Draft PR on Shortage

### Task 5.1: Create the auto-pr-from-shortage helper

**Files:**
- Create: `src/lib/auto-pr-from-shortage.ts`

- [ ] **Step 1: Write the helper**

Create `src/lib/auto-pr-from-shortage.ts`:

```ts
import type { Prisma, PurchaseRequisition } from '@prisma/client'

const OPEN_PR_STATUSES = ['draft', 'pending', 'approved'] as const

export async function maybeCreateDraftPrForShortage(
  materialId: string,
  shortage: number,
  tx: Prisma.TransactionClient,
): Promise<PurchaseRequisition | null> {
  if (shortage <= 0) return null

  const existing = await tx.purchaseRequisition.findFirst({
    where: {
      materialId,
      status: { in: OPEN_PR_STATUSES as unknown as string[] },
    },
    select: { id: true },
  })
  if (existing) return null

  const material = await tx.inventory.findUnique({
    where: { id: materialId },
    select: { boardType: true, gsm: true, sizeLabel: true, lastRate: true },
  })
  if (!material) return null

  return tx.purchaseRequisition.create({
    data: {
      materialId,
      qtyRequired: shortage,
      estimatedValue: shortage * (Number(material.lastRate) || 0),
      triggerReason: 'auto_shortage',
      status: 'draft',
      raisedBy: null,
      boardType: material.boardType,
      sizeLabel: material.sizeLabel,
      gsm: material.gsm,
    },
  })
}
```

If `Inventory` does not have a `lastRate` field, find the rate column name with `grep -n "lastRate\|currentRate\|unitPrice\|@map(\"rate\"" prisma/schema.prisma` and substitute.

- [ ] **Step 2: Verify TS compiles**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/auto-pr-from-shortage.ts
git commit -m "feat(procurement): auto-create draft PR helper with dedupe on open statuses"
```

### Task 5.2: Smoke test the dedupe logic

**Files:**
- Create: `scripts/test-auto-pr-from-shortage.ts`

- [ ] **Step 1: Write the test**

Create `scripts/test-auto-pr-from-shortage.ts`:

```ts
/**
 * Smoke test: maybeCreateDraftPrForShortage
 * - First call with shortage > 0 creates a PR
 * - Second call returns null (dedupe)
 * - Cleanup deletes the created PR
 */
import { PrismaClient } from '@prisma/client'
import { maybeCreateDraftPrForShortage } from '../src/lib/auto-pr-from-shortage'

const prisma = new PrismaClient()

async function main() {
  // Find a material with NO open PR currently
  const candidates = await prisma.inventory.findMany({ select: { id: true }, take: 50 })
  let materialId: string | null = null
  for (const c of candidates) {
    const open = await prisma.purchaseRequisition.findFirst({
      where: { materialId: c.id, status: { in: ['draft', 'pending', 'approved'] } },
    })
    if (!open) { materialId = c.id; break }
  }
  if (!materialId) {
    console.log('SKIP: every sampled material already has an open PR')
    return
  }

  // Test 1: creates a PR
  const created = await prisma.$transaction(async (tx) => {
    return maybeCreateDraftPrForShortage(materialId!, 100, tx)
  })
  console.assert(created !== null, 'should have created a PR')
  console.assert(created!.status === 'draft', `status should be draft, got ${created!.status}`)
  console.assert(created!.raisedBy === null, `raisedBy should be null, got ${created!.raisedBy}`)
  console.log('PASS: creates draft PR')

  // Test 2: dedupe
  const second = await prisma.$transaction(async (tx) => {
    return maybeCreateDraftPrForShortage(materialId!, 100, tx)
  })
  console.assert(second === null, `second call should return null (dedupe), got ${second?.id}`)
  console.log('PASS: dedupes on open PR existing')

  // Test 3: shortage = 0 short-circuit
  await prisma.purchaseRequisition.delete({ where: { id: created!.id } })
  const zero = await prisma.$transaction(async (tx) => {
    return maybeCreateDraftPrForShortage(materialId!, 0, tx)
  })
  console.assert(zero === null, `shortage=0 should return null`)
  console.log('PASS: shortage=0 short-circuit')
}

main().catch((e) => { console.error('FAIL:', e); process.exit(1) })
```

- [ ] **Step 2: Run it — expect PASS**

Run: `npx tsx scripts/test-auto-pr-from-shortage.ts`
Expected: three PASS lines.

- [ ] **Step 3: Commit**

```bash
git add scripts/test-auto-pr-from-shortage.ts
git commit -m "test(procurement): dedupe + shortage=0 smoke for auto-PR helper"
```

### Task 5.3: Wire helper into recalculateMaterialShortage

**Files:**
- Modify: `src/lib/reservation-release.ts`

- [ ] **Step 1: Import and call the helper**

In `src/lib/reservation-release.ts`, update `recalculateMaterialShortage`:

```ts
import { maybeCreateDraftPrForShortage } from './auto-pr-from-shortage'

export async function recalculateMaterialShortage(
  materialId: string,
  tx: ReleaseTxClient,
): Promise<{ shortage: number; prCreated: boolean }> {
  const active = await tx.materialReservation.findMany({
    where: {
      materialId,
      isReleased: false,
      jobCard: {
        status: { in: ACTIVE_RESERVATION_STATUSES as unknown as string[] },
      },
    },
    select: { requiredSheets: true, reservedSheets: true },
  })

  const shortage = active.reduce(
    (sum, r) => sum + Math.max(0, Number(r.requiredSheets) - Number(r.reservedSheets)),
    0,
  )

  let prCreated = false
  if (shortage > 0) {
    // Note: maybeCreateDraftPrForShortage requires Prisma.TransactionClient.
    // If tx is the bare prisma client (called outside a tx), this still works
    // because $extends-wrapped clients support .findFirst/.create on models.
    const created = await maybeCreateDraftPrForShortage(materialId, shortage, tx as Prisma.TransactionClient)
    prCreated = created !== null
  }

  return { shortage, prCreated }
}
```

- [ ] **Step 2: Re-run reservation-release smoke test**

Run: `npx tsx scripts/test-reservation-release.ts`
Expected: all three tests still PASS. If a PR was auto-created during testEndToEnd, that's expected — the cleanup in testEndToEnd already reverts the reservation state, so subsequent runs are clean. If a stray draft PR is left, delete it manually with prisma studio.

- [ ] **Step 3: Commit**

```bash
git add src/lib/reservation-release.ts
git commit -m "feat(reservations): recalc fires auto-PR creation when shortage > 0"
```

### Task 5.4: Add Draft lane + Auto badge to PR kanban

**Files:**
- Modify: `src/app/(dashboard)/inventory/purchase-requisitions/page.tsx`

- [ ] **Step 1: Read the file structure**

Run: `head -120 src/app/(dashboard)/inventory/purchase-requisitions/page.tsx`
Identify the kanban-lane definition (likely an array of status keys).

- [ ] **Step 2: Add 'draft' as the leftmost lane**

Find the lanes array (e.g. `const LANES = ['pending', 'approved', 'converted_to_po', 'rejected']`). Change to:

```ts
const LANES = ['draft', 'pending', 'approved', 'converted_to_po', 'rejected'] as const
```

Add a column header/label for "Draft" in the kanban rendering.

- [ ] **Step 3: Render Auto badge on cards with raisedBy=null**

In the per-card renderer, conditionally show:

```tsx
{pr.raisedBy === null && (
  <span className="text-[10px] px-1.5 py-0.5 rounded bg-ds-warning/15 text-ds-warning font-semibold uppercase">
    ⚡ Auto
  </span>
)}
```

- [ ] **Step 4: Add Promote-to-Pending button on draft cards**

For draft-lane cards only:

```tsx
{pr.status === 'draft' && (
  <button
    onClick={async () => {
      await fetch(`/api/purchase-requisitions/${pr.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'pending' }),
      })
      // refresh page data — match existing pattern
      window.location.reload()
    }}
    className="text-[11px] px-2 py-1 rounded bg-ds-brand text-white hover:opacity-90"
  >
    Promote to Pending
  </button>
)}
```

If the existing PATCH endpoint rejects `draft → pending` transition, find that endpoint and add `draft` to its allowed prior-status set.

- [ ] **Step 5: Manual smoke**

Run: `npm run dev`. Navigate to `/inventory/purchase-requisitions`. Confirm Draft lane appears with any auto-created PRs from earlier testing.

- [ ] **Step 6: Commit**

```bash
git add src/app/(dashboard)/inventory/purchase-requisitions/page.tsx
git commit -m "feat(ui): PR kanban Draft lane with Auto badge + Promote-to-Pending"
```

---

## Phase 6: Theme Overhaul

### Task 6.1: Update design-tokens.css with new palette

**Files:**
- Modify: `src/styles/design-tokens.css`

- [ ] **Step 1: Read the existing file**

Run: `cat src/styles/design-tokens.css | head -60`
Note current values for `--bg-card`, `--ds-brand`, `--ds-success`, `--ds-danger`, `--ds-warning`, `--ds-line`, `--ds-ink`, `--ds-ink-muted`, `--font-body`, `--font-heading`, `--font-mono`.

- [ ] **Step 2: Replace token values**

Update the `:root` block in `src/styles/design-tokens.css`:

```css
:root {
  /* Base palette */
  --bg-app: #0f1117;
  --bg-card: #181c27;
  --bg-elevated: #1f2433;

  /* Brand & semantic */
  --ds-brand: #f5820d;
  --ds-success: #22c55e;
  --ds-danger: #ef4444;
  --ds-warning: #eab308;
  --ds-info: #3b82f6;

  /* Lines & ink */
  --ds-line: rgba(255, 255, 255, 0.08);
  --ds-ink: #e5e7eb;
  --ds-ink-muted: #9ca3af;
  --ds-ink-faint: #6b7280;

  /* Fonts */
  --font-body: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif;
  --font-heading: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif;
  --font-label: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif;
  --font-mono: 'IBM Plex Mono', ui-monospace, 'SF Mono', monospace;
}
```

Preserve any other token names already in the file that aren't listed above (extend, don't replace).

- [ ] **Step 3: Commit**

```bash
git add src/styles/design-tokens.css
git commit -m "feat(theme): dark palette + Plus Jakarta Sans + IBM Plex Mono tokens"
```

### Task 6.2: Update globals.css HSL vars and add mono font to numeric classes

**Files:**
- Modify: `src/app/globals.css`

- [ ] **Step 1: Update HSL shadcn vars (lines 64–84)**

Replace the `:root` HSL block in `src/app/globals.css` with:

```css
:root {
  /* Backgrounds (HSL of #0f1117 / #181c27) */
  --background: 224 19% 8%;
  --foreground: 220 13% 91%;
  --card: 222 19% 13%;
  --card-foreground: 220 13% 91%;
  --primary: 26 92% 51%;
  --primary-foreground: 0 0% 100%;
  --secondary: 218 15% 20%;
  --secondary-foreground: 220 13% 91%;
  --muted: 218 15% 20%;
  --muted-foreground: 220 9% 65%;
  --accent: 26 92% 51%;
  --accent-foreground: 0 0% 100%;
  --destructive: 0 84% 60%;
  --destructive-foreground: 0 0% 100%;
  --input: 218 15% 20%;
  /* …keep any other HSL vars in the existing file with adjusted hues */
}
```

- [ ] **Step 2: Add mono font to numeric classes**

Find `.ds-input-num`, `.ds-typo-total`, `.ds-typo-kpi` (lines 17–53). Update each to include `font-family: var(--font-mono)`:

```css
.ds-input-num {
  @apply tabular-nums tracking-tight text-ds-ink;
  font-family: var(--font-mono);
}
/* and similarly on ds-typo-total, ds-typo-kpi */
```

- [ ] **Step 3: Commit**

```bash
git add src/app/globals.css
git commit -m "feat(theme): dark HSL vars + IBM Plex Mono on numeric classes"
```

### Task 6.3: Load fonts via next/font/google

**Files:**
- Modify: `src/app/layout.tsx`

- [ ] **Step 1: Add font imports**

At the top of `src/app/layout.tsx`:

```ts
import { Plus_Jakarta_Sans, IBM_Plex_Mono } from 'next/font/google'

const jakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-jakarta',
})
const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
  variable: '--font-plex-mono',
})
```

- [ ] **Step 2: Attach to root html element**

In the layout's JSX root, add the variables to className:

```tsx
<html lang="en" className={`${jakarta.variable} ${plexMono.variable}`}>
```

- [ ] **Step 3: Update design-tokens.css to use the CSS variables**

Back in `src/styles/design-tokens.css`, change font tokens to:

```css
--font-body: var(--font-jakarta), system-ui, -apple-system, sans-serif;
--font-heading: var(--font-jakarta), system-ui, -apple-system, sans-serif;
--font-label: var(--font-jakarta), system-ui, -apple-system, sans-serif;
--font-mono: var(--font-plex-mono), ui-monospace, 'SF Mono', monospace;
```

- [ ] **Step 4: Run dev and verify**

Run: `npm run dev`. Open any page. Inspect element on body text and a number; confirm font family is Plus Jakarta Sans for text and IBM Plex Mono for numbers.

- [ ] **Step 5: Commit**

```bash
git add src/app/layout.tsx src/styles/design-tokens.css
git commit -m "feat(theme): load Plus Jakarta Sans + IBM Plex Mono via next/font/google"
```

### Task 6.4: Update tokens.ts hardcoded hex constants

**Files:**
- Modify: `src/components/design-system/tokens.ts`

- [ ] **Step 1: Read the file**

Run: `cat src/components/design-system/tokens.ts`
Note any exported hex constants used in inline styles or chart configs.

- [ ] **Step 2: Update color constants**

Replace any hex values that should follow the new palette:
- Brand orange → `#f5820d`
- Success green → `#22c55e`
- Danger red → `#ef4444`
- Warning yellow → `#eab308`
- Info blue → `#3b82f6`
- Card background → `#181c27`
- App background → `#0f1117`

Leave CMYK channel swatches (`#FF00FF` etc., used by Plate Hub) untouched.

- [ ] **Step 3: Commit**

```bash
git add src/components/design-system/tokens.ts
git commit -m "feat(theme): align tokens.ts hex constants with new palette"
```

### Task 6.5: Hardcoded-color sweep on paper-warehouse page

**Files:**
- Modify: `src/app/(dashboard)/inventory/page.tsx`

- [ ] **Step 1: Grep for hardcoded tailwind colors in this file**

Run: `grep -nE "(bg|text|border)-(red|green|yellow|blue|orange|emerald|amber)-[0-9]{3}" src/app/\(dashboard\)/inventory/page.tsx`
Note every match.

- [ ] **Step 2: Replace semantically**

For each match, replace with the semantic token equivalent. Mapping:
- `red-*` → `ds-danger`
- `green-*` / `emerald-*` → `ds-success`
- `yellow-*` / `amber-*` → `ds-warning`
- `blue-*` → `ds-info`
- `orange-*` → `ds-brand`

Decorative colors (e.g. status pills where a designer chose the exact shade for hierarchy) — preserve them, the sweep is for semantic colors only.

Example:
```tsx
// Before: className="text-red-600 bg-red-50"
// After:  className="text-ds-danger bg-ds-danger/15"
```

- [ ] **Step 3: Verify visually**

Run: `npm run dev`. Open `/inventory`. Confirm the page renders with the new palette and no broken styling.

- [ ] **Step 4: Commit**

```bash
git add src/app/(dashboard)/inventory/page.tsx
git commit -m "style(theme): paper-warehouse page hardcoded-color sweep to semantic tokens"
```

### Task 6.6: Hardcoded-color sweep on PR-kanban page

**Files:**
- Modify: `src/app/(dashboard)/inventory/purchase-requisitions/page.tsx`

- [ ] **Step 1: Grep for hardcoded colors**

Run: `grep -nE "(bg|text|border)-(red|green|yellow|blue|orange|emerald|amber)-[0-9]{3}" src/app/\(dashboard\)/inventory/purchase-requisitions/page.tsx`

- [ ] **Step 2: Replace per same mapping as Task 6.5**

Apply the same red→ds-danger / green→ds-success / etc. substitutions.

- [ ] **Step 3: Verify visually**

Run: `npm run dev`. Open `/inventory/purchase-requisitions`. Confirm rendering.

- [ ] **Step 4: Commit**

```bash
git add src/app/(dashboard)/inventory/purchase-requisitions/page.tsx
git commit -m "style(theme): PR kanban hardcoded-color sweep to semantic tokens"
```

---

## Final Verification

- [ ] **Run full TS check**

Run: `npx tsc --noEmit`
Expected: PASS, zero errors.

- [ ] **Run lint**

Run: `npm run lint`
Expected: PASS or only warnings on files outside this PR's scope.

- [ ] **Run all smoke tests**

```bash
npx tsx scripts/test-reservation-release.ts
npx tsx scripts/test-days-of-cover.ts
npx tsx scripts/test-auto-pr-from-shortage.ts
```
Expected: all PASS.

- [ ] **Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Manual end-to-end smoke**

Run: `npm run dev`. In the browser:
1. Navigate to `/inventory` — confirm dark theme, Plus Jakarta Sans text, IBM Plex Mono numbers
2. Click a Reserved cell with value > 0 — panel opens
3. Check Days of Cover column shows colored badges
4. Navigate to `/inventory/purchase-requisitions` — confirm Draft lane visible
5. Change a job card status to `cancelled` via job-cards admin UI — confirm its reservations release and any resulting shortage spawns a draft PR

---

## Rollback Cheat Sheet

If something goes wrong:
- **Schema (Phase 1):** `npx prisma migrate resolve --rolled-back reservation_release_fields` + write a manual revert SQL dropping the four columns and re-adding `raisedBy NOT NULL`
- **Helpers + wiring (Phases 2, 4, 5):** revert PRs in reverse order — no data side effects beyond auto-created draft PRs (delete those manually if needed)
- **UI (Phases 3, 4, 5):** revert PRs — pure cosmetic
- **Theme (Phase 6):** revert PR — pure cosmetic
